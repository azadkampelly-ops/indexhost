
const message = document.getElementById("message");
const startButton = document.getElementById("startButton");

const uploadForm = document.getElementById("uploadForm");
const uploadMessage = document.getElementById("uploadMessage");

async function checkPlatform() {
  try {
    const response = await fetch("/api/health");

    if (!response.ok) {
      throw new Error("Server error");
    }

    const data = await response.json();

    message.textContent =
      `${data.platform} is ${data.status}. Dashboard connected successfully.`;
  } catch {
    message.textContent =
      "Cannot connect to INDEX Host. Please start the server.";
  }
}

startButton.addEventListener("click", () => {
  document.getElementById("projects").scrollIntoView({
    behavior: "smooth"
  });
});

// Load all published websites into the dashboard.
async function loadPublishedSites() {
  const projects = document.getElementById("projects");
  if (!projects) return;

  let section = document.getElementById("publishedSites");

  if (!section) {
    section = document.createElement("section");
    section.id = "publishedSites";
    section.style.cssText = "margin-top:30px;";
    projects.appendChild(section);
  }

  section.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = "Published Websites";
  section.appendChild(heading);

  try {
    const response = await fetch("/api/sites");

    if (!response.ok) {
      throw new Error("Could not load published websites.");
    }

    const data = await response.json();

    if (data.sites.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No websites published yet.";
      section.appendChild(empty);
      return;
    }

    data.sites.forEach(site => {
      const card = document.createElement("div");

      card.style.cssText = [
        "background:#fff",
        "color:#172033",
        "padding:18px",
        "margin:12px 0",
        "border:1px solid #e2e8f0",
        "border-radius:12px"
      ].join(";");

      const title = document.createElement("h3");
      title.textContent = site.name;

      const address = document.createElement("p");
      address.textContent = site.url;

      const link = document.createElement("a");
      link.href = site.url;
      link.textContent = "Open website";
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      card.append(title, address, link);
      section.appendChild(card);
    });
  } catch (error) {
    const errorMessage = document.createElement("p");
    errorMessage.textContent = error.message;
    section.appendChild(errorMessage);
  }
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const websiteName =
    document.getElementById("websiteName").value.trim();

  const websiteZip =
    document.getElementById("websiteZip").files[0];

  uploadMessage.replaceChildren();

  if (!/^[a-z0-9-]{1,50}$/.test(websiteName)) {
    uploadMessage.textContent =
      "Use lowercase letters, numbers, and hyphens for the website name.";
    return;
  }

  if (!websiteZip || !websiteZip.name.toLowerCase().endsWith(".zip")) {
    uploadMessage.textContent = "Please select a ZIP file.";
    return;
  }

  if (websiteZip.size > 10 * 1024 * 1024) {
    uploadMessage.textContent =
      "The ZIP file must be 10 MB or smaller.";
    return;
  }

  const formData = new FormData();
  formData.append("websiteName", websiteName);
  formData.append("websiteZip", websiteZip);

  const submitButton = uploadForm.querySelector(
    'button[type="submit"]'
  );

  submitButton.disabled = true;
  submitButton.textContent = "Uploading...";
  uploadMessage.textContent =
    "Uploading and checking your website...";

  try {
    const response = await fetch("/api/sites", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload failed.");
    }

    uploadMessage.textContent = data.message + " ";

    const link = document.createElement("a");
    link.href = data.url;
    link.textContent = "Open your website";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    uploadMessage.appendChild(link);
    uploadForm.reset();

    // Refresh the dashboard list after a successful upload.
    await loadPublishedSites();
  } catch (error) {
    uploadMessage.textContent =
      error.message || "Upload failed. Please try again.";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Upload website";
  }
});

checkPlatform();
loadPublishedSites();
