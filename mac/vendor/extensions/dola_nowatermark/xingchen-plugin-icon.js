(() => {
  const styleId = "xingchen-dola-plugin-icon-style";
  const iconUrl = chrome.runtime.getURL("xingchen-plugin-icon.png");
  let scanPending = false;

  function patchShadowRoot(root) {
    if (!root) return;
    const button = root.querySelector(".toggle-btn");
    if (!button) return;

    const toggleIcon = button.querySelector(".toggle-icon");
    if (toggleIcon && toggleIcon.getAttribute("src") !== iconUrl) {
      toggleIcon.setAttribute("src", iconUrl);
    }
    const brandIcon = root.querySelector(".xingchen-brand-icon");
    if (brandIcon && brandIcon.getAttribute("src") !== iconUrl) {
      brandIcon.setAttribute("src", iconUrl);
    }

    if (root.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .toggle-btn.xingchen-ready,
      .toggle-btn:has(.toggle-icon) {
        color: #fff !important;
      }
      .toggle-icon,
      .xingchen-brand-icon {
        image-rendering: auto;
      }
    `;
    root.appendChild(style);
    button.classList.add("xingchen-ready");
  }

  function scan() {
    scanPending = false;
    for (const element of document.querySelectorAll("*")) {
      if (element.shadowRoot) patchShadowRoot(element.shadowRoot);
    }
  }

  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    requestAnimationFrame(scan);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  scheduleScan();
  setInterval(scheduleScan, 2000);
})();
