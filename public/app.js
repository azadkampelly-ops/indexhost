
"use strict";

const $ = (id) => document.getElementById(id);

const loginPanel = $("loginPanel");
const appShell = $("appShell");
const loginForm = $("loginForm");
const loginButton = $("loginButton");
const adminPassword = $("adminPassword");
const loginMessage = $("loginMessage");
const logoutButton = $("logoutButton");
const uploadForm = $("uploadForm");
const uploadButton = $("uploadButton");
const uploadMessage = $("uploadMessage");
const dashboardMessage = $("dashboardMessage");
const refreshButton = $("refreshButton");
const sitesTableBody = $("sitesTableBody");
const siteSearch = $("siteSearch");

let allSites = [];
let refreshInProgress = false;

$("currentYear").textContent = new Date().getFullYear();

function showMessage(element, message, type = "") {
  element.textContent = message;
  element.className = "form-message" + (type ? ` ${type}` : "");
}

function showDashboardNotice(message = "", isError = false) {
  dashboardMessage.textContent = message;
  dashboardMessage.className = "notice" + (isError ? " error" : "");
  dashboardMessage.hidden = !message;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    if (response.status === 401) {
      setAuthenticated(false);
    }
    throw new Error(data.message || `Request failed (${response.status})`);
  }

  return data;
}

function setAuthenticated(authenticated) {
  loginPanel.hidden = authenticated;
  appShell.hidden = !authenticated;

  if (!authenticated) {
    adminPassword.value = "";
    allSites = [];
  }
}

function setServerStatus(online, label = "") {
  const text = label || (online ? "Online" : "Unavailable");
  $("sidebarStatus").textContent = text;
  $("platformStatus").textContent = online ? "Online" : "Offline";
  $("platformNote").textContent = online
    ? "Server health check passed"
    : "Could not confirm server health";

  $("sidebarStatusDot").className =
    "status-dot " + (online ? "online" : "offline");

  const adminDot = document.querySelector(".admin-pill .status-dot");
  if (adminDot) {
    adminDot.className = "status-dot " + (online ? "online" : "offline");
  }
}

function getSiteUrl(site) {
  if (site.url) {
    try {
      const url = new URL(site.url, window.location.origin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.href;
      }
    } catch {
      // Use the standard INDEX Host site route below.
    }
  }

  return `/sites/${encodeURIComponent(site.name)}/`;
}

function formatDate(value) {
  if (!value) return "Date unavailable";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function getValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function updateStatistics(sites) {
  $("totalSites").textContent = sites.length;

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const recent = sites.filter((site) => {
    const date = getValidDate(site.created_at);
    return date && date.getTime() >= weekAgo && date.getTime() <= now;
  });

  $("recentSites").textContent = recent.length;

  const sorted = [...sites].sort((a, b) => {
    const aDate = getValidDate(a.created_at)?.getTime() || 0;
    const bDate = getValidDate(b.created_at)?.getTime() || 0;
    return bDate - aDate;
  });

  if (sorted.length) {
    $("latestSite").textContent = sorted[0].name || "Unnamed";
    $("latestDate").textContent = formatDate(sorted[0].created_at);
  } else {
    $("latestSite").textContent = "—";
    $("latestDate").textContent = "No uploads yet";
  }
}

function renderSites() {
  const query = siteSearch.value.trim().toLowerCase();

  const filtered = allSites.filter((site) =>
    String(site.name || "").toLowerCase().includes(query)
  );

  sitesTableBody.replaceChildren();

  if (!filtered.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "empty-state";
    cell.textContent = allSites.length
      ? "No websites match your search."
      : "No websites published yet. Upload your first website above.";
    row.appendChild(cell);
    sitesTableBody.appendChild(row);
    $("siteCount").textContent = allSites.length
      ? "0 matching websites"
      : "0 websites";
    return;
  }

  filtered.forEach((site) => {
    const row = document.createElement("tr");

    const websiteCell = document.createElement("td");
    const siteIdentity = document.createElement("div");
    siteIdentity.className = "site-cell";

    const icon = document.createElement("span");
    icon.className = "site-icon";
    icon.textContent = String(site.name || "W").charAt(0).toUpperCase();

    const identityText = document.createElement("div");
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.name || "Unnamed website";

    const subtitle = document.createElement("span");
    subtitle.className = "site-subtitle";
    subtitle.textContent = "Static website";

    identityText.append(name, subtitle);
    siteIdentity.append(icon, identityText);
    websiteCell.appendChild(siteIdentity);

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(site.created_at);

    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = "published-pill";
    status.textContent = "Published";
    statusCell.appendChild(status);

    const actionCell = document.createElement("td");
    const link = document.createElement("a");
    link.className = "action-link";
    link.href = getSiteUrl(site);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open site ↗";
    actionCell.appendChild(link);

    row.append(websiteCell, dateCell, statusCell, actionCell);
    sitesTableBody.appendChild(row);
  });

  $("siteCount").textContent =
    `${filtered.length} website${filtered.length === 1 ? "" : "s"}`;
}

async function checkServerHealth() {
  try {
    const response = await fetch("/api/health", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) throw new Error("Health check failed");

    setServerStatus(true);
  } catch {
    // Health endpoint may not be available in every existing server version.
    // The website list and login are checked independently.
    setServerStatus(false, "Health check unavailable");
  }
}

async function loadSites() {
  const data = await apiRequest("/api/sites", {
    cache: "no-store"
  });

  if (!Array.isArray(data.sites)) {
    throw new Error("The website list response was not in the expected format.");
  }

  allSites = data.sites;
  updateStatistics(allSites);
  renderSites();
}

async function refreshDashboard() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";
  showDashboardNotice();

  try {
    await Promise.all([loadSites(), checkServerHealth()]);
    showDashboardNotice("Dashboard data refreshed.");
    window.setTimeout(() => showDashboardNotice(), 2500);
  } catch (error) {
    showDashboardNotice(error.message || "Could not load dashboard data.", true);
  } finally {
    refreshInProgress = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "↻ Refresh data";
  }
}

async function checkLoginStatus() {
  try {
    const data = await apiRequest("/api/admin/status", {
      cache: "no-store"
    });

    setAuthenticated(data.authenticated === true);

    if (data.authenticated === true) {
      await refreshDashboard();
    } else {
      adminPassword.focus();
    }
  } catch {
    setAuthenticated(false);
    showMessage(
      loginMessage,
      "Could not check login status. Make sure the server is running, then refresh.",
      "error"
    );
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(loginMessage, "");

  loginButton.disabled = true;
  loginButton.textContent = "Signing in…";

  try {
    const data = await apiRequest("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword.value })
    });

    if (data.authenticated !== true) {
      throw new Error("Login was not confirmed by the server.");
    }

    setAuthenticated(true);
    adminPassword.value = "";
    await refreshDashboard();
  } catch (error) {
    showMessage(loginMessage, error.message || "Sign-in failed.", "error");
  } finally {
    loginButton.disabled = false;
    loginButton.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await apiRequest("/api/admin/logout", { method: "POST" });
    setAuthenticated(false);
    showMessage(loginMessage, "You have signed out.", "success");
  } catch (error) {
    showDashboardNotice(error.message || "Sign-out failed.", true);
  } finally {
    logoutButton.disabled = false;
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(uploadMessage, "");

  const name = $("websiteName").value.trim();
  const file = $("websiteZip").files[0];

  if (!/^[a-z0-9-]{1,50}$/.test(name)) {
    showMessage(
      uploadMessage,
      "Use 1–50 lowercase letters, numbers or hyphens for the website name.",
      "error"
    );
    return;
  }

  if (!file || !file.name.toLowerCase().endsWith(".zip")) {
    showMessage(uploadMessage, "Please select a ZIP file.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("websiteName", name);
  formData.append("websiteZip", file);

  uploadButton.disabled = true;
  uploadButton.textContent = "Uploading…";

  try {
    const data = await apiRequest("/api/sites", {
      method: "POST",
      body: formData
    });

    showMessage(uploadMessage, data.message || "Website published successfully.", "success");
    uploadForm.reset();

    await loadSites();
    await checkServerHealth();

    if (data.url) {
      const link = document.createElement("a");
      link.href = getSiteUrl({ name, url: data.url });
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = " Open published website ↗";
      link.className = "action-link";

      uploadMessage.appendChild(document.createTextNode(" "));
      uploadMessage.appendChild(link);
    }
  } catch (error) {
    showMessage(uploadMessage, error.message || "Website upload failed.", "error");
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = "Upload & publish ↗";
  }
});

refreshButton.addEventListener("click", refreshDashboard);
siteSearch.addEventListener("input", renderSites);

$("menuButton").addEventListener("click", () => {
  const isOpen = $("sidebar").classList.toggle("open");
  $("menuButton").setAttribute("aria-expanded", String(isOpen));
});

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    $("sidebar").classList.remove("open");
    $("menuButton").setAttribute("aria-expanded", "false");
  });
});

checkLoginStatus();
