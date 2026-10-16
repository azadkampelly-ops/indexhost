
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const yauzl = require("yauzl");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(os.tmpdir(), "indexhost-uploads");
const BUCKET = "indexhost-sites";

const ADMIN_PASSWORD = process.env.INDEX_HOST_ADMIN_PASSWORD;
const SESSION_SECRET = process.env.INDEX_HOST_SESSION_SECRET;

if (!process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase environment variables are missing.");
}

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  throw new Error("Admin authentication environment variables are missing.");
}

if (SESSION_SECRET.length < 32) {
  throw new Error("Session secret must be at least 32 characters long.");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.disable("x-powered-by");

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Local testing only. Configure a persistent session store before
// deploying this application to Render for production use.
app.use(session({
  name: "indexhost.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 1000,
    path: "/"
  }
}));

app.use(express.json({ limit: "10kb" }));

// Authentication middleware.
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  return res.status(401).json({
    error: "Please log in as the INDEX Host administrator."
  });
}

// Restrict browser state-changing requests to the same origin.
function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");

  if (!origin) {
    return res.status(403).json({
      error: "Origin header is required."
    });
  }

  try {
    const originUrl = new URL(origin);
    const host = req.get("host");

    if (
      !host ||
      originUrl.host !== host ||
      !["http:", "https:"].includes(originUrl.protocol)
    ) {
      return res.status(403).json({
        error: "Cross-origin request blocked."
      });
    }
  } catch {
    return res.status(403).json({
      error: "Invalid request origin."
    });
  }

  next();
}

// Basic in-memory login rate limiter for local testing.
// Use a persistent/shared rate limiter in production.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;

function checkLoginLimit(ip) {
  const now = Date.now();
  let record = loginAttempts.get(ip);

  if (!record || now - record.startedAt >= LOGIN_WINDOW_MS) {
    record = { startedAt: now, count: 0 };
    loginAttempts.set(ip, record);
  }

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    return false;
  }

  record.count++;
  return true;
}

const limiterCleanup = setInterval(() => {
  const now = Date.now();

  for (const [ip, record] of loginAttempts) {
    if (now - record.startedAt >= LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000);

limiterCleanup.unref();

// Admin login.
app.post("/api/admin/login", requireSameOrigin, (req, res, next) => {
  const ip = req.ip || "unknown";

  if (!checkLoginLimit(ip)) {
    return res.status(429).json({
      error: "Too many login attempts. Try again in 15 minutes."
    });
  }

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  const suppliedHash = crypto
    .createHash("sha256")
    .update(password)
    .digest();

  const expectedHash = crypto
    .createHash("sha256")
    .update(ADMIN_PASSWORD)
    .digest();

  if (!crypto.timingSafeEqual(suppliedHash, expectedHash)) {
    return res.status(401).json({
      error: "Incorrect admin password."
    });
  }

  // Regenerate session ID after successful authentication.
  req.session.regenerate(error => {
    if (error) return next(error);

    req.session.isAdmin = true;

    req.session.save(error => {
      if (error) return next(error);

      // IMPORTANT: frontend checks authenticated === true.
      return res.json({
        authenticated: true,
        message: "Admin login successful."
      });
    });
  });
});

// Check current authentication status.
app.get("/api/admin/status", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    authenticated: req.session?.isAdmin === true
  });
});

// Admin logout.
app.post(
  "/api/admin/logout",
  requireSameOrigin,
  requireAdmin,
  (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);

      res.clearCookie("indexhost.sid", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/"
      });

      return res.json({
        message: "Logged out successfully."
      });
    });
  }
);

// ZIP upload configuration.
const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter(req, file, callback) {
    if (path.extname(file.originalname).toLowerCase() !== ".zip") {
      return callback(new Error("Please upload a ZIP file."));
    }

    callback(null, true);
  }
});

// Static dashboard files.
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (req, res) => {
  res.json({
    platform: "INDEX Host",
    status: "running"
  });
});

// List published websites and their creation dates.
app.get("/api/sites", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("hosted_sites")
      .select("name, created_at")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      sites: data.map(site => ({
        name: site.name,
        url: `/sites/${site.name}/`,
        created_at: site.created_at
      }))
    });
  } catch (error) {
    console.error("List sites error:", error.message);

    res.status(500).json({
      error: "Could not load published websites."
    });
  }
});

// Safely extract a ZIP file.
function extractZip(zipPath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) return reject(error);

      let finished = false;
      let ended = false;
      let totalBytes = 0;
      let fileCount = 0;

      const pending = new Set();
      const maxFiles = 1000;
      const maxTotalBytes = 50 * 1024 * 1024;

      function fail(err) {
        if (finished) return;

        finished = true;

        try {
          zipfile.close();
        } catch {}

        reject(err);
      }

      function checkDone() {
        if (!finished && ended && pending.size === 0) {
          finished = true;
          resolve();
        }
      }

      zipfile.on("error", fail);

      zipfile.on("end", () => {
        ended = true;
        checkDone();
      });

      zipfile.on("entry", entry => {
        if (finished) return;

        fileCount++;

        if (fileCount > maxFiles) {
          return fail(new Error("ZIP contains too many files."));
        }

        const name = entry.fileName.replace(/\\/g, "/");
        const parts = name.split("/");

        if (
          !name ||
          name.startsWith("/") ||
          /^[a-zA-Z]:/.test(name) ||
          parts.some(part => part === "..") ||
          name.includes("\0")
        ) {
          return fail(new Error("ZIP contains an unsafe file path."));
        }

        const outputPath = path.resolve(destination, name);

        if (
          outputPath !== destination &&
          !outputPath.startsWith(destination + path.sep)
        ) {
          return fail(new Error("ZIP contains an unsafe file path."));
        }

        if (name.endsWith("/")) {
          try {
            fs.mkdirSync(outputPath, { recursive: true });
            zipfile.readEntry();
          } catch (err) {
            fail(err);
          }

          return;
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);

          if (finished) {
            stream.destroy();
            return;
          }

          const task = new Promise((resolveFile, rejectFile) => {
            try {
              fs.mkdirSync(path.dirname(outputPath), {
                recursive: true
              });
            } catch (err) {
              stream.destroy();
              rejectFile(err);
              return;
            }

            const output = fs.createWriteStream(outputPath, {
              flags: "wx"
            });

            let settled = false;

            function settle(err) {
              if (settled) return;
              settled = true;

              if (err) {
                output.destroy();
                rejectFile(err);
              } else {
                resolveFile();
              }
            }

            stream.on("data", chunk => {
              totalBytes += chunk.length;

              if (totalBytes > maxTotalBytes) {
                stream.destroy(
                  new Error("ZIP expands beyond the 50 MB limit.")
                );
              }
            });

            stream.on("error", settle);
            output.on("error", settle);
            output.on("finish", () => settle());

            stream.pipe(output);
          });

          pending.add(task);

          task.then(() => {
            pending.delete(task);
            checkDone();

            if (!finished) zipfile.readEntry();
          }).catch(fail);
        });
      });

      zipfile.readEntry();
    });
  });
}

// Collect regular files and reject symbolic links.
function getWebsiteFiles(root) {
  const files = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, {
      withFileTypes: true
    })) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed in website ZIPs.");
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push({
          fullPath,
          relativePath: path.relative(root, fullPath)
            .split(path.sep)
            .join("/")
        });
      }
    }
  }

  walk(root);
  return files;
}

// Upload and publish a website.
// Admin authentication is checked before the ZIP is processed.
app.post(
  "/api/sites",
  requireSameOrigin,
  requireAdmin,
  (req, res) => {
    upload.single("websiteZip")(req, res, async uploadError => {
      if (uploadError) {
        return res.status(400).json({
          error: uploadError.message
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Choose a ZIP file."
        });
      }

      const name = String(req.body.websiteName || "").trim();

      if (!/^[a-z0-9-]{1,50}$/.test(name)) {
        fs.unlink(req.file.path, () => {});

        return res.status(400).json({
          error: "Use 1–50 lowercase letters, numbers, or hyphens."
        });
      }

      const staging = path.join(
        UPLOADS_DIR,
        `.staging-${crypto.randomUUID()}`
      );

      const uploadedPaths = [];
      let siteRecordCreated = false;

      try {
        const { data: existing, error: lookupError } = await supabase
          .from("hosted_sites")
          .select("name")
          .eq("name", name)
          .maybeSingle();

        if (lookupError) throw lookupError;

        if (existing) {
          return res.status(409).json({
            error: "That website name already exists."
          });
        }

        fs.mkdirSync(staging, { recursive: true });

        await extractZip(req.file.path, staging);

        let websiteRoot = staging;
        let entries = fs.readdirSync(staging);

        // Support ZIPs containing a single top-level folder.
        if (
          !entries.some(file => file.toLowerCase() === "index.html") &&
          entries.length === 1 &&
          fs.statSync(path.join(staging, entries[0])).isDirectory()
        ) {
          websiteRoot = path.join(staging, entries[0]);
          entries = fs.readdirSync(websiteRoot);
        }

        const homepage = entries.find(
          file => file.toLowerCase() === "index.html"
        );

        if (!homepage) {
          throw new Error("ZIP must contain an index.html file.");
        }

        if (homepage !== "index.html") {
          fs.renameSync(
            path.join(websiteRoot, homepage),
            path.join(websiteRoot, "index.html")
          );
        }

        const files = getWebsiteFiles(websiteRoot);

        if (!files.length) {
          throw new Error("Website ZIP contains no files.");
        }

        // Upload each file into Supabase Storage.
        for (const file of files) {
          const objectPath = `${name}/${file.relativePath}`;
          const contents = fs.readFileSync(file.fullPath);

          const { error } = await supabase.storage
            .from(BUCKET)
            .upload(objectPath, contents, {
              contentType:
                require("mime-types").lookup(file.relativePath) ||
                "application/octet-stream",
              upsert: false
            });

          if (error) throw error;

          uploadedPaths.push(objectPath);
        }

        // Save the site record after all files upload successfully.
        const { error: insertError } = await supabase
          .from("hosted_sites")
          .insert({ name });

        if (insertError) throw insertError;

        siteRecordCreated = true;

        return res.status(201).json({
          message: "Website uploaded successfully.",
          url: `/sites/${name}/`
        });
      } catch (error) {
        console.error("Website publish error:", error.message);

        // Remove any files from a failed publishing attempt.
        for (let i = 0; i < uploadedPaths.length; i += 100) {
          try {
            const { error: removeError } = await supabase.storage
              .from(BUCKET)
              .remove(uploadedPaths.slice(i, i + 100));

            if (removeError) {
              console.error("Storage cleanup error:", removeError.message);
            }
          } catch (cleanupError) {
            console.error("Storage cleanup error:", cleanupError.message);
          }
        }

        if (siteRecordCreated) {
          const { error: deleteError } = await supabase
            .from("hosted_sites")
            .delete()
            .eq("name", name);

          if (deleteError) {
            console.error("Site record cleanup error:", deleteError.message);
          }
        }

        return res.status(400).json({
          error: error.message || "Could not publish website."
        });
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.unlink(req.file.path, () => {});
      }
    });
  }
);

// Serve published website files from the private Supabase bucket.
app.use("/sites/:siteName", async (req, res) => {
  const name = req.params.siteName;

  if (!/^[a-z0-9-]{1,50}$/.test(name)) {
    return res.status(400).send("Invalid website name.");
  }

  let relativePath;

  try {
    relativePath = decodeURIComponent(req.path || "/");
  } catch {
    return res.status(400).send("Invalid file path.");
  }

  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some(
      part => part === ".." || part.startsWith(".")
    )
  ) {
    return res.status(400).send("Invalid file path.");
  }

  if (relativePath === "/" || relativePath.endsWith("/")) {
    relativePath += "index.html";
  }

  const objectPath =
    `${name}/${relativePath.replace(/^\/+/, "")}`;

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(objectPath);

    if (error || !data) {
      return res.status(404).send("File not found.");
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const mimeType = require("mime-types").lookup(relativePath);

    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "public, max-age=300");

    if (mimeType) res.type(mimeType);

    return res.send(buffer);
  } catch (error) {
    console.error("Website file error:", error.message);
    return res.status(500).send("Could not load website file.");
  }
});

// General error handler.
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "An internal server error occurred."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`INDEX Host is running on port ${PORT}`);
});
