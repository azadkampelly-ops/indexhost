
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const yauzl = require("yauzl");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const SITES_DIR = path.join(__dirname, "sites");
const UPLOADS_DIR = path.join(__dirname, "uploads");

for (const dir of [SITES_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.disable("x-powered-by");

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

app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (req, res) => {
  res.json({
    platform: "INDEX Host",
    status: "running"
  });
});

// List published websites.
app.get("/api/sites", (req, res) => {
  try {
    const sites = fs.readdirSync(SITES_DIR, {
      withFileTypes: true
    })
      .filter(entry =>
        entry.isDirectory() &&
        /^[a-z0-9-]{1,50}$/.test(entry.name)
      )
      .filter(entry => {
        const indexPath = path.join(
          SITES_DIR,
          entry.name,
          "index.html"
        );

        return fs.existsSync(indexPath) &&
          fs.statSync(indexPath).isFile();
      })
      .map(entry => ({
        name: entry.name,
        url: `/sites/${entry.name}/`
      }));

    res.json({ sites });
  } catch {
    res.status(500).json({
      error: "Could not load published websites."
    });
  }
});

// Safely extract ZIP files with size and path checks.
function extractZip(zipPath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true },
      (error, zipfile) => {
        if (error) return reject(error);

        let finished = false;
        let totalBytes = 0;
        let fileCount = 0;
        const maxFiles = 1000;
        const maxTotalBytes = 50 * 1024 * 1024;
        const pending = new Set();

        function fail(err) {
          if (finished) return;
          finished = true;
          zipfile.close();
          reject(err);
        }

        function finishIfReady() {
          if (finished) return;

          if (pending.size === 0) {
            finished = true;
            resolve();
          }
        }

        zipfile.on("error", fail);

        zipfile.on("end", () => {
          Promise.all([...pending])
            .then(finishIfReady)
            .catch(fail);
        });

        zipfile.on("entry", entry => {
          if (finished) return;

          fileCount++;

          if (fileCount > maxFiles) {
            return fail(
              new Error("ZIP contains too many files.")
            );
          }

          const name = entry.fileName.replace(/\\/g, "/");

          if (
            !name ||
            name.startsWith("/") ||
            /^[a-zA-Z]:/.test(name) ||
            name.split("/").some(part => part === "..") ||
            name.includes("\0")
          ) {
            return fail(
              new Error("ZIP contains an unsafe file path.")
            );
          }

          const outputPath = path.resolve(destination, name);

          if (
            outputPath !== destination &&
            !outputPath.startsWith(destination + path.sep)
          ) {
            return fail(
              new Error("ZIP contains an unsafe file path.")
            );
          }

          const isDirectory = name.endsWith("/");

          // Create directories without trying to read them as files.
          if (isDirectory) {
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

            const writeTask = new Promise(
              (resolveFile, rejectFile) => {
                fs.mkdirSync(path.dirname(outputPath), {
                  recursive: true
                });

                const output = fs.createWriteStream(
                  outputPath,
                  { flags: "wx" }
                );

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
                      new Error(
                        "ZIP expands beyond the 50 MB limit."
                      )
                    );
                  }
                });

                stream.on("error", settle);
                output.on("error", settle);
                output.on("finish", () => settle());
                stream.pipe(output);
              }
            );

            pending.add(writeTask);

            writeTask.then(() => {
              pending.delete(writeTask);
              finishIfReady();
            }).catch(fail);

            // Wait for this entry's data to finish before
            // advancing to the next ZIP entry.
            writeTask.then(() => {
              if (!finished) zipfile.readEntry();
            }).catch(() => {});
          });
        });

        zipfile.readEntry();
      }
    );
  });
}

// Upload and publish a website.
app.post("/api/sites", (req, res) => {
  upload.single("websiteZip")(
    req,
    res,
    async uploadError => {
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

      const name = String(
        req.body.websiteName || ""
      ).trim();

      if (!/^[a-z0-9-]{1,50}$/.test(name)) {
        fs.unlink(req.file.path, () => {});

        return res.status(400).json({
          error:
            "Use 1–50 lowercase letters, numbers, or hyphens."
        });
      }

      const destination = path.join(SITES_DIR, name);

      if (fs.existsSync(destination)) {
        fs.unlink(req.file.path, () => {});

        return res.status(409).json({
          error: "That website name already exists."
        });
      }

      const staging = path.join(
        SITES_DIR,
        `.staging-${crypto.randomUUID()}`
      );

      try {
        fs.mkdirSync(staging);

        await extractZip(req.file.path, staging);

        let websiteRoot = staging;
        let entries = fs.readdirSync(staging);

        // Also support ZIPs containing one top-level folder.
        if (
          !entries.some(
            file => file.toLowerCase() === "index.html"
          ) &&
          entries.length === 1 &&
          fs.statSync(
            path.join(staging, entries[0])
          ).isDirectory()
        ) {
          websiteRoot = path.join(staging, entries[0]);
          entries = fs.readdirSync(websiteRoot);
        }

        if (
          !entries.some(
            file => file.toLowerCase() === "index.html"
          )
        ) {
          throw new Error(
            "ZIP must contain an index.html file."
          );
        }

        // Ensure a predictable filename for the homepage.
        const homepage = entries.find(
          file => file.toLowerCase() === "index.html"
        );

        if (homepage !== "index.html") {
          fs.renameSync(
            path.join(websiteRoot, homepage),
            path.join(websiteRoot, "index.html")
          );
        }

        fs.renameSync(websiteRoot, destination);

        if (websiteRoot !== staging) {
          fs.rmSync(staging, {
            recursive: true,
            force: true
          });
        }

        res.status(201).json({
          message: "Website uploaded successfully.",
          url: `/sites/${name}/`
        });
      } catch (error) {
        fs.rmSync(staging, {
          recursive: true,
          force: true
        });

        res.status(400).json({
          error:
            error.message ||
            "Could not process ZIP file."
        });
      } finally {
        fs.unlink(req.file.path, () => {});
      }
    }
  );
});

// Serve published websites and their assets.
app.use("/sites/:siteName", (req, res, next) => {
  const name = req.params.siteName;

  if (!/^[a-z0-9-]{1,50}$/.test(name)) {
    return res.status(400).send("Invalid website name.");
  }

  const root = path.join(SITES_DIR, name);

  if (
    !fs.existsSync(root) ||
    !fs.statSync(root).isDirectory()
  ) {
    return res.status(404).send("Website not found.");
  }

  express.static(root, {
    index: "index.html",
    dotfiles: "deny"
  })(req, res, next);
});

app.use("/sites/:siteName", (req, res) => {
  res.status(404).send("File not found.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `INDEX Host is running on port ${PORT}`
  );
});
