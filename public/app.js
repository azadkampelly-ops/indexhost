
"use strict";

const $ = (id) => document.getElementById(id);

const loginPanel = $("loginPanel");
const dashboardPanel = $("dashboardPanel");
const authForm = $("authForm");
const accountEmail = $("accountEmail");
const accountPassword = $("accountPassword");
const confirmPassword = $("confirmPassword");
const confirmPasswordField = $("confirmPasswordField");
const authButton = $("authButton");
const authTitle = $("authTitle");
const authDescription = $("authDescription");
const authSwitchText = $("authSwitchText");
const authSwitchButton = $("authSwitchButton");
const loginMessage = $("loginMessage");
const logoutButton = $("logoutButton");
const accountLabel = $("accountLabel");

const uploadForm = $("uploadForm");
const websiteName = $("websiteName");
const websiteZip = $("websiteZip");
const uploadButton = $("uploadButton");
const uploadMessage = $("uploadMessage");

const totalSites = $("totalSites");
const publishedSites = $("publishedSites");
const sitesList = $("sitesList");
const sitesMessage = $("sitesMessage");
const siteSearch = $("siteSearch");
const refreshButton = $("refreshButton");

let authMode = "login";
let sites = [];
let loadingSites = false;
let uploading = false;
let checkingAuth = false;

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function showMessage(element, message, type = "") {
  if (!element) return;

  element.textContent = message;
  element.classList.remove("success", "error");

  if (type) {
    element.classList.add(type);
  }
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });

  const contentType = response.headers.get("content-type") || "";
  let data = {};

  if (contentType.includes("application/json")) {
    data = await response.json();
  }

  if (!response.ok) {
    if (response.status === 401) {
      setAuthenticated(false);
    }

    throw new Error(data.error || `Request failed (${response.status}).`);
  }

  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return replacements[character];
  });
}

function formatDate(value) {
  if (!value) return "Date unavailable";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

// --------------------------------------------------
// AUTHENTICATION UI
// --------------------------------------------------

function setAuthMode(mode) {
  authMode = mode === "signup" ? "signup" : "login";

  const isSignup = authMode === "signup";

  authTitle.textContent = isSignup ? "Create your account" : "Welcome back";

  authDescription.textContent = isSignup
    ? "Create an account to publish and manage your websites."
    : "Sign in to manage your websites.";

  authButton.textContent = isSignup ? "Create account" : "Sign in";

  authSwitchText.textContent = isSignup
    ? "Already have an account?"
    : "Don't have an account?";

  authSwitchButton.textContent = isSignup ? "Sign in" : "Create account";

  confirmPasswordField.hidden = !isSignup;
  confirmPassword.required = isSignup;

  accountPassword.autocomplete = isSignup
    ? "new-password"
    : "current-password";

  confirmPassword.autocomplete = "new-password";
}

function setAuthenticated(authenticated, email = "") {
  loginPanel.hidden = authenticated;
  dashboardPanel.hidden = !authenticated;

  if (authenticated) {
    accountLabel.textContent = email || "Signed in";
    showMessage(loginMessage, "");
  } else {
    accountLabel.textContent = "";
    sites = [];
    updateStatistics([]);
    renderSites();
  }
}

authSwitchButton.addEventListener("click", () => {
  showMessage(loginMessage, "");
  setAuthMode(authMode === "login" ? "signup" : "login");
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = accountEmail.value.trim().toLowerCase();
  const password = accountPassword.value;

  if (!email || !password) {
    showMessage(loginMessage, "Enter your email and password.", "error");
    return;
  }

  if (authMode === "signup") {
    if (password.length < 10 || password.length > 128) {
      showMessage(
        loginMessage,
        "Password must be 10–128 characters long.",
        "error"
      );
      return;
    }

    if (password !== confirmPassword.value) {
      showMessage(loginMessage, "Passwords do not match.", "error");
      return;
    }
  }

  authButton.disabled = true;
  authButton.textContent = authMode === "signup"
    ? "Creating account..."
    : "Signing in...";

  showMessage(loginMessage, "");

  try {
    const endpoint = authMode === "signup"
      ? "/api/auth/signup"
      : "/api/auth/login";

    const result = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (result.requiresEmailConfirmation) {
      // Switch modes first, then show the confirmation message.
      setAuthMode("login");
      accountPassword.value = "";
      confirmPassword.value = "";

      showMessage(
        loginMessage,
        result.message ||
          "Check your email to confirm your account, then sign in.",
        "success"
      );

      return;
    }

    setAuthenticated(true, result.email || email);

    authForm.reset();
    confirmPassword.value = "";

    await loadSites();
  } catch (error) {
    showMessage(
      loginMessage,
      error.message || "Authentication failed. Please try again.",
      "error"
    );
  } finally {
    authButton.disabled = false;
    authButton.textContent =
      authMode === "signup" ? "Create account" : "Sign in";
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await apiRequest("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    console.error("Sign-out request failed:", error);
  } finally {
    setAuthenticated(false);
    setAuthMode("login");
    authForm.reset();
    logoutButton.disabled = false;
    showMessage(loginMessage, "");
  }
});

// --------------------------------------------------
// WEBSITE STATISTICS
// --------------------------------------------------

function updateStatistics(list) {
  totalSites.textContent = String(list.length);
  publishedSites.textContent = String(list.length);
}

// --------------------------------------------------
// WEBSITE LIST
// --------------------------------------------------

function renderSites() {
  const query = siteSearch.value.trim().toLowerCase();

  const filtered = sites.filter((site) =>
    String(site.name || "").toLowerCase().includes(query)
  );

  updateStatistics(sites);

  if (!filtered.length) {
    sitesList.replaceChildren();

    const empty = document.createElement("p");
    empty.textContent = query
      ? "No websites match your search."
      : "You haven't published any websites yet.";

    sitesList.appendChild(empty);
    return;
  }

  // Names and dates are escaped before insertion into HTML.
  sitesList.innerHTML = filtered.map((site) => {
    const name = escapeHtml(site.name);
    const date = escapeHtml(formatDate(site.created_at));
    const encodedName = encodeURIComponent(site.name);
    const publicUrl = `/sites/${encodedName}/`;

    return `
      <article class="site-card">
        <div class="site-info">
          <h3>${name}</h3>
          <p>Published ${date}</p>
          <p class="site-url">${escapeHtml(publicUrl)}</p>
        </div>

        <div class="site-actions">
          <a
            class="button-link"
            href="${escapeHtml(publicUrl)}"
            target="_blank"
            rel="noopener noreferrer"
          >Visit website</a>

          <button
            type="button"
            class="copy-site-button"
            data-site-url="${escapeHtml(publicUrl)}"
          >Copy link</button>
        </div>
      </article>
    `;
  }).join("");
}

sitesList.addEventListener("click", async (event) => {
  const button = event.target.closest(".copy-site-button");

  if (!button) return;

  const url = new URL(button.dataset.siteUrl, window.location.origin).href;

  try {
    await navigator.clipboard.writeText(url);
    const previousText = button.textContent;
    button.textContent = "Copied!";

    setTimeout(() => {
      button.textContent = previousText;
    }, 1500);
  } catch {
    window.prompt("Copy this website link:", url);
  }
});

siteSearch.addEventListener("input", renderSites);

async function loadSites() {
  if (loadingSites || dashboardPanel.hidden) return;

  loadingSites = true;
  refreshButton.disabled = true;
  showMessage(sitesMessage, "Loading your websites...");

  try {
    const result = await apiRequest("/api/sites");

    sites = Array.isArray(result.sites) ? result.sites : [];

    renderSites();
    showMessage(
      sitesMessage,
      `${sites.length} website${sites.length === 1 ? "" : "s"} found.`,
      "success"
    );
  } catch (error) {
    sites = [];
    renderSites();

    showMessage(
      sitesMessage,
      error.message || "Could not load your websites.",
      "error"
    );
  } finally {
    loadingSites = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadSites);

// --------------------------------------------------
// WEBSITE UPLOAD
// --------------------------------------------------

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (uploading) return;

  const name = websiteName.value.trim().toLowerCase();
  const file = websiteZip.files[0];

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      name.length < 3 ||
      name.length > 50) {
    showMessage(
      uploadMessage,
      "Use 3–50 lowercase letters, numbers and hyphens for the website name.",
      "error"
    );
    return;
  }

  if (!file) {
    showMessage(uploadMessage, "Choose a ZIP file first.", "error");
    return;
  }

  if (!file.name.toLowerCase().endsWith(".zip")) {
    showMessage(uploadMessage, "Choose a .zip file.", "error");
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    showMessage(uploadMessage, "ZIP file must not exceed 10 MB.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("websiteName", name);
  formData.append("websiteZip", file);

  uploading = true;
  uploadButton.disabled = true;
  uploadButton.textContent = "Publishing...";
  showMessage(uploadMessage, "Uploading and publishing your website...");

  try {
    const result = await apiRequest("/api/sites", {
      method: "POST",
      body: formData
    });

    showMessage(
      uploadMessage,
      "Website published successfully!",
      "success"
    );

    uploadForm.reset();

    await loadSites();

    if (result.site?.url) {
      const link = document.createElement("a");
      link.href = result.site.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = " Open published website";
      uploadMessage.appendChild(link);
    }
  } catch (error) {
    showMessage(
      uploadMessage,
      error.message || "Website upload failed.",
      "error"
    );
  } finally {
    uploading = false;
    uploadButton.disabled = false;
    uploadButton.textContent = "Publish website";
  }
});

// --------------------------------------------------
// INITIAL AUTHENTICATION CHECK
// --------------------------------------------------

async function initializeApp() {
  if (checkingAuth) return;

  checkingAuth = true;
  setAuthenticated(false);
  setAuthMode("login");

  try {
    const result = await apiRequest("/api/auth/status");

    if (result.authenticated) {
      setAuthenticated(true, result.email || "");
      await loadSites();
    } else {
      setAuthenticated(false);
    }
  } catch (error) {
    setAuthenticated(false);
    showMessage(
      loginMessage,
      "Unable to connect to INDEX Host. Refresh the page and try again.",
      "error"
    );
  } finally {
    checkingAuth = false;
  }
}

initializeApp();
