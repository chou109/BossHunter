const browsers = {
  chrome: { label: "Chrome", url: "chrome://extensions" },
  edge: { label: "Edge", url: "edge://extensions" },
  brave: { label: "Brave", url: "brave://extensions" },
  opera: { label: "Opera", url: "opera://extensions" },
  vivaldi: { label: "Vivaldi", url: "vivaldi://extensions" },
};

const urlEl = document.getElementById("extensions-url");
const detectedEl = document.getElementById("detected-browser");
const copyBtn = document.getElementById("copy-url");
const tabs = Array.from(document.querySelectorAll("[data-browser]"));
const toast = document.getElementById("toast");
const header = document.querySelector(".site-header");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxCap = document.getElementById("lightbox-cap");
const lightboxClose = document.getElementById("lightbox-close");
const shots = Array.from(document.querySelectorAll(".shot"));

let currentBrowser = "chrome";
let toastTimer;
let copyTimer;

function setBrowser(key, updateDetected = true) {
  if (!browsers[key]) return;
  currentBrowser = key;
  urlEl.textContent = browsers[key].url;
  tabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.browser === key);
  });
  if (updateDetected) {
    detectedEl.textContent = browsers[key].label;
  }
}

async function detectBrowser() {
  const ua = navigator.userAgent;
  let key = "chrome";

  if (/Edg\//.test(ua)) {
    key = "edge";
  } else if (/OPR\//.test(ua)) {
    key = "opera";
  } else if (/Vivaldi\//.test(ua)) {
    key = "vivaldi";
  } else if (navigator.brave && typeof navigator.brave.isBrave === "function") {
    try {
      if (await navigator.brave.isBrave()) key = "brave";
    } catch {
      // Brave detection is best-effort; Chrome remains a safe default.
    }
  }

  setBrowser(key);
  detectedEl.textContent = navigator.brave && key === "brave" ? "Brave" : browsers[key].label;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => {
      toast.hidden = true;
    }, 200);
  }, 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement("input");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    input.remove();
    return ok;
  }
}

async function handleCopy() {
  const url = browsers[currentBrowser].url;
  const ok = await copyText(url);

  copyBtn.textContent = ok ? "已复制" : "请手动复制";
  copyBtn.classList.toggle("is-copied", ok);
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copyBtn.textContent = "复制地址";
    copyBtn.classList.remove("is-copied");
  }, 1800);

  showToast(ok ? `已复制 ${url}，粘贴到地址栏回车` : `请手动复制 ${url}`);
}

function openLightbox(shot) {
  lightboxImg.src = shot.dataset.full;
  lightboxImg.alt = shot.querySelector("img")?.alt || "BossHunter 面板截图";
  lightboxCap.textContent = shot.dataset.caption || "";
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
  lightboxClose.focus();
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = "";
  document.body.style.overflow = "";
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setBrowser(tab.dataset.browser));
});

copyBtn?.addEventListener("click", handleCopy);

shots.forEach((shot) => {
  shot.addEventListener("click", () => openLightbox(shot));
});

lightboxClose?.addEventListener("click", closeLightbox);
lightbox?.addEventListener("click", (event) => {
  if (event.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.hidden) closeLightbox();
});

function onScroll() {
  header.classList.toggle("is-scrolled", window.scrollY > 12);
}

window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

detectBrowser().catch(() => {
  setBrowser("chrome");
  detectedEl.textContent = "Chromium";
});
