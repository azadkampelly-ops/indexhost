
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const Store = session.Store;
const multer = require("multer");
const yauzl = require("yauzl");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const mime = require("mime-types");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const BUCKET = "indexhost-sites";
const SESSION_COOKIE = "indexhost.sid";
const SESSION_TTL_MS = 60 * 60 * 1000;

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  INDEX_HOST_SESSION_SECRET
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing Supabase environment variables. Check your private .env file."
  );
}

if (!INDEX_HOST_SESSION_SECRET || INDEX_HOST_SESSION_SECRET.length < 32) {
  throw new Error("INDEX_HOST_SESSION_SECRET must be at least 32 characters.");
}

// Backend-only database and storage client.
// NEVER expose the service-role key in frontend JavaScript.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

// Create a separate auth client for each authentication request.
function makeAuthClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

app.disable("x-powered-by");

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "10kb" }));

// --------------------------------------------------
// PERSISTENT SESSION STORE
// Requires public.indexhost_sessions:
// sid TEXT PRIMARY KEY, sess JSONB, expire TIMESTAMPTZ
// --------------------------------------------------

class SupabaseSessionStore extends Store {
  get(sid, callback) {
    (async () => {
      const { data, error } = await supabase
        .from("indexhost_sessions")
        .select("sess")
        .eq("sid", sid)
        .gt("expire", new Date().toISOString())
        .maybeSingle();

      if (error) throw error;
      callback(null, data ? data.sess : null);
    })().catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    (async () => {
      const expires = sess?.cookie?.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + SESSION_TTL_MS);

      const { error } = await supabase
        .from("indexhost_sessions")
        .upsert(
          { sid, sess, expire: expires.toISOString() },
          { onConflict: "sid" }
        );

      if (error) throw error;
      callback(null);
    })().catch(callback);
  }

  destroy(sid, callback = () => {}) {
    (async () => {
      const { error } = await supabase
        .from("indexhost_sessions")
        .delete()
        .eq("sid", sid);

      if (error) throw error;
      callback(null);
    })().catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    (async () => {
      const expires = sess?.cookie?.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + SESSION_TTL_MS);

      const { error } = await supabase
        .from("indexhost_sessions")
        .update({ expire: expires.toISOString() })
        .eq("sid", sid);

      if (error) throw error;
      callback(null);
    })().catch(callback);
  }
}

app.use(
  session({
    name: SESSION_COOKIE,
    secret: INDEX_HOST_SESSION_SECRET,
    store: new SupabaseSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
      path: "/"
    }
  })
);

// --------------------------------------------------
// REQUEST SECURITY AND HELPERS
// --------------------------------------------------

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");

  if (!origin) {
    return res.status(403).json({ error: "Origin header is required." });
  }

  try {
    const originUrl = new URL(origin);

    if (
      !req.get("host") ||
      originUrl.host !== req.get("host") ||
      !["http:", "https:"].includes(originUrl.protocol)
    ) {
      return res.status(403).json({ error: "Cross-origin request blocked." });
    }
  } catch {
    return res.status(403).json({ error: "Invalid request origin." });
  }

  next();
}

function requireUser(req, res, next) {
  if (typeof req.session?.userId === "string" && req.session.userId) {
    return next();
  }

  return res.status(401).json({ error: "Please sign in to continue." });
}

const attempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 10;

function allowAttempt(key) {
  const now = Date.now();
  let record = attempts.get(key);

  if (!record || now - record.startedAt >= RATE_WINDOW_MS) {
    record = { startedAt: now, count: 0 };
    attempts.set(key, record);
  }

  if (record.count >= RATE_LIMIT) return false;

  record.count++;
  return true;
}

const limiterCleanup = setInterval(() => {
  const now = Date.now();

  for (const [key, record] of attempts) {
    if (now - record.startedAt >= RATE_WINDOW_MS) {
      attempts.delete(key);
    }
  }
}, 10 * 60 * 1000);

limiterCleanup.unref();

function validEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  );
}

function validPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 10 &&
    password.length <= 128
  );
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}

function sendServerError(res, message = "An unexpected error occurred.") {
  return res.status(500).json({ error: message });
}

// --------------------------------------------------
// HEALTH AND AUTHENTICATION
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ platform: "INDEX Host", status: "running" });
});

app.get("/api/auth/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    authenticated: Boolean(req.session?.userId),
    email: req.session?.email || null
  });
});

app.post("/api/auth/signup", requireSameOrigin, async (req, res, next) => {
  if (!allowAttempt(`signup:${req.ip}`)) {
    return res.status(429).json({
      error: "Too many attempts. Try again in 15 minutes."
    });
  }

  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const password = req.body?.password;

  if (!validEmail(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  if (!validPassword(password)) {
    return res.status(400).json({
      error: "Password must be 10–128 characters long."
    });
  }

  try {
    const auth = makeAuthClient();
    const { data, error } = await auth.auth.signUp({ email, password });

    if (error) {
      return res.status(400).json({
        error: "Could not create your account. Check your details and try again."
      });
    }

    if (!data.user) {
      return res.status(400).json({
        error: "Account creation could not be confirmed."
      });
    }

    if (!data.session) {
      return res.status(201).json({
        authenticated: false,
        requiresEmailConfirmation: true,
        message: "Check your email to confirm your account, then sign in."
      });
    }

    await regenerateSession(req);
    req.session.userId = data.user.id;
    req.session.email = data.user.email || email;
    await saveSession(req);

    res.status(201).json({
      authenticated: true,
      email: req.session.email
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", requireSameOrigin, async (req, res, next) => {
  if (!allowAttempt(`login:${req.ip}`)) {
    return res.status(429).json({
      error: "Too many attempts. Try again in 15 minutes."
    });
  }

  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const password = req.body?.password;

  if (!validEmail(email) || typeof password !== "string") {
    return res.status(400).json({ error: "Enter your email and password." });
  }

  try {
    const auth = makeAuthClient();
    const { data, error } = await auth.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data.user) {
      return res.status(401).json({
        error: "Invalid email or password, or email confirmation is required."
      });
    }

    await regenerateSession(req);
    req.session.userId = data.user.id;
    req.session.email = data.user.email || email;
    await saveSession(req);

    res.set("Cache-Control", "no-store");
    res.json({
      authenticated: true,
      email: req.session.email
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireSameOrigin, async (req, res, next) => {
  try {
    if (req.session) {
      await destroySession(req);
    }

    clearSessionCookie(res);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// PUBLIC FRONTEND
// --------------------------------------------------

app.use(express.static(PUBLIC_DIR));

// --------------------------------------------------
// ZIP UPLOAD CONFIGURATION
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith(".zip")) {
      return callback(new Error("Upload a .zip website file."));
    }

    callback(null, true);
  }
});

function validSiteName(name) {
  return (
    typeof name === "string" &&
    name.length >= 3 &&
    name.length <= 50 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  );
}

function safeZipPath(rawName) {
  if (
    typeof rawName !== "string" ||
    rawName.includes("\0") ||
    rawName.includes("\\") ||
    rawName.startsWith("/") ||
    /^[a-zA-Z]:/.test(rawName)
  ) {
    throw new Error("ZIP contains an unsafe file path.");
  }

  const parts = rawName.split("/");

  if (
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        part.length === 0
    )
  ) {
    throw new Error("ZIP contains an unsafe file path.");
  }

  return parts.join("/");
}

// Read ZIP entries into memory, enforcing entry count and total-size limits.
function readZipEntries(zipBuffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      zipBuffer,
      { lazyEntries: true, decodeStrings: true },
      (openError, zipfile) => {
        if (openError) return reject(new Error("Invalid ZIP file."));

        const files = new Map();
        let totalSize = 0;
        let entryCount = 0;
        let finished = false;

        function fail(error) {
          if (finished) return;
          finished = true;

          try {
            zipfile.close();
          } catch {}

          reject(error);
        }

        zipfile.on("error", () => fail(new Error("Could not read ZIP file.")));

        zipfile.on("end", () => {
          if (finished) return;
          finished = true;
          resolve(files);
        });

        zipfile.on("entry", (entry) => {
          if (finished) return;

          entryCount++;

          if (entryCount > 1000) {
            return fail(new Error("ZIP contains too many entries."));
          }

          let relativePath;

          try {
            relativePath = safeZipPath(entry.fileName);
          } catch (error) {
            return fail(error);
          }

          // Ignore directories.
          if (relativePath.endsWith("/")) {
            return zipfile.readEntry();
          }

          // Reject Unix symbolic links.
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;

          if (fileType === 0o120000) {
            return fail(new Error("ZIP symbolic links are not allowed."));
          }

          if (files.has(relativePath)) {
            return fail(new Error("ZIP contains duplicate file paths."));
          }

          if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            return fail(new Error("ZIP contains an invalid file size."));
          }

          totalSize += entry.uncompressedSize;

          if (totalSize > 50 * 1024 * 1024) {
            return fail(new Error("Uncompressed ZIP must not exceed 50 MB."));
          }

          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              return fail(new Error("Could not read a ZIP entry."));
            }

            const chunks = [];
            let actualSize = 0;

            stream.on("data", (chunk) => {
              actualSize += chunk.length;

              if (actualSize > 50 * 1024 * 1024) {
                stream.destroy(new Error("ZIP entry is too large."));
                return;
              }

              chunks.push(chunk);
            });

            stream.on("error", () => {
              fail(new Error("Could not extract ZIP entry."));
            });

            stream.on("end", () => {
              if (finished) return;

              if (actualSize !== entry.uncompressedSize) {
                return fail(new Error("ZIP entry size mismatch."));
              }

              files.set(relativePath, Buffer.concat(chunks));
              zipfile.readEntry();
            });
          });
        });

        zipfile.readEntry();
      }
    );
  });
}

// Support ZIPs that contain either index.html at the root or
// one common enclosing folder.
function normalizeWebsiteFiles(files) {
  if (files.has("index.html")) return files;

  const names = [...files.keys()];
  const firstSegments = new Set(names.map((name) => name.split("/")[0]));

  if (firstSegments.size !== 1) return files;

  const prefix = [...firstSegments][0] + "/";
  const normalized = new Map();

  for (const [name, buffer] of files) {
    if (!name.startsWith(prefix)) return files;

    const relative = name.slice(prefix.length);
    if (!relative) continue;

    normalized.set(relative, buffer);
  }

  return normalized;
}

// --------------------------------------------------
// PRIVATE DASHBOARD API
// Each account only sees its own records.
// --------------------------------------------------

app.get("/api/sites", requireUser, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("hosted_sites")
      .select("id, name, created_at")
      .eq("owner_id", req.session.userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.set("Cache-Control", "no-store");
    res.json({ sites: data || [] });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/sites",
  requireSameOrigin,
  requireUser,
  upload.single("websiteZip"),
  async (req, res, next) => {
    const siteName =
      typeof req.body?.websiteName === "string"
        ? req.body.websiteName.trim().toLowerCase()
        : "";

    if (!validSiteName(siteName)) {
      return res.status(400).json({
        error:
          "Website name must be 3–50 characters using lowercase letters, numbers and single hyphens."
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Choose a ZIP file to upload." });
    }

    let siteRecordCreated = false;
    let uploadedPaths = [];

    try {
      let files = await readZipEntries(req.file.buffer);
      files = normalizeWebsiteFiles(files);

      if (!files.has("index.html")) {
        return res.status(400).json({
          error: "Your ZIP must contain an index.html file."
        });
      }

      if (files.size === 0 || files.size > 1000) {
        return res.status(400).json({
          error: "Website must contain between 1 and 1000 files."
        });
      }

      // Reserve the globally unique site name and assign ownership.
      const { data: site, error: insertError } = await supabase
        .from("hosted_sites")
        .insert({
          name: siteName,
          owner_id: req.session.userId
        })
        .select("id, name, created_at")
        .single();

      if (insertError) {
        if (insertError.code === "23505") {
          return res.status(409).json({
            error: "That website name is already taken. Choose another."
          });
        }

        throw insertError;
      }

      siteRecordCreated = true;

      for (const [relativePath, buffer] of files) {
        // safeZipPath already validated relativePath.
        const storagePath = `${siteName}/${relativePath}`;
        const contentType =
          mime.lookup(relativePath) || "application/octet-stream";

        const { error: storageError } = await supabase.storage
          .from(BUCKET)
          .upload(storagePath, buffer, {
            contentType,
            upsert: false
          });

        if (storageError) throw storageError;

        uploadedPaths.push(storagePath);
      }

      res.status(201).json({
        success: true,
        site: {
          id: site.id,
          name: site.name,
          created_at: site.created_at,
          url: `/sites/${encodeURIComponent(site.name)}/`
        }
      });
    } catch (error) {
      // Roll back any files uploaded for this failed publication.
      if (uploadedPaths.length) {
        await supabase.storage.from(BUCKET).remove(uploadedPaths);
      }

      if (siteRecordCreated) {
        await supabase
          .from("hosted_sites")
          .delete()
          .eq("name", siteName)
          .eq("owner_id", req.session.userId);
      }

      next(error);
    }
  }
);

// --------------------------------------------------
// PUBLIC WEBSITE DELIVERY
// Published website pages remain publicly accessible.
// Management APIs above remain account-protected.
// --------------------------------------------------

app.get(/^\/sites\/([^/]+)(?:\/(.*))?$/, async (req, res, next) => {
  try {
    const siteName = req.params[0];
    const requestedPath = req.params[1] || "index.html";

    if (!validSiteName(siteName)) {
      return res.status(404).send("Website not found.");
    }

    let relativePath;

    try {
      relativePath = safeZipPath(requestedPath);
    } catch {
      return res.status(400).send("Invalid website path.");
    }

    const { data: site, error: siteError } = await supabase
      .from("hosted_sites")
      .select("id")
      .eq("name", siteName)
      .maybeSingle();

    if (siteError) throw siteError;

    if (!site) {
      return res.status(404).send("Website not found.");
    }

    const storagePath = `${siteName}/${relativePath}`;

    const { data: file, error: fileError } = await supabase.storage
      .from(BUCKET)
      .download(storagePath);

    if (fileError || !file) {
      return res.status(404).send("Page not found.");
    }

    const contentType =
      mime.lookup(relativePath) || "application/octet-stream";

    res.set("Content-Type", contentType);
    res.set("X-Content-Type-Options", "nosniff");

    if (relativePath.endsWith(".html")) {
      res.set("Cache-Control", "no-cache");
    } else {
      res.set("Cache-Control", "public, max-age=300");
    }

    const arrayBuffer = await file.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "ZIP file must not exceed 10 MB."
        : "Upload failed. Check your ZIP file and try again.";

    return res.status(400).json({ error: message });
  }

  if (
    err.message === "Upload a .zip website file." ||
    err.message === "Invalid ZIP file." ||
    err.message === "ZIP contains an unsafe file path." ||
    err.message === "ZIP symbolic links are not allowed." ||
    err.message === "ZIP contains duplicate file paths." ||
    err.message === "ZIP contains too many entries." ||
    err.message === "ZIP contains an invalid file size." ||
    err.message === "Uncompressed ZIP must not exceed 50 MB." ||
    err.message === "Could not read a ZIP entry." ||
    err.message === "Could not extract ZIP entry." ||
    err.message === "ZIP entry size mismatch."
  ) {
    return res.status(400).json({ error: err.message });
  }

  console.error("INDEX Host error:", err);
  return sendServerError(res);
});

app.listen(PORT, () => {
  console.log(`INDEX Host running on port ${PORT}`);
});
