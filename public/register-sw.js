"use strict";
/**
 * Distributed with Ultraviolet and compatible with most configurations.
 */
const stockSW = "/uv.sw.js";

/**
 * List of hostnames that are allowed to run serviceworkers on http:
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

/**
 * Global util
 * Used in 404.html and index.html
 */

let _arsenicSwPromise = null;

async function registerSW() {
  // GAMP / AMP cache context: the page is on cdn.ampproject.org but
  // assets (including SW scripts) live on the worker origin.
  // Service workers cannot be registered cross-origin, so we use a
  // hidden iframe loaded from the worker origin to register them there.
  if (
    window.__ARSENIC_ORIGIN__ &&
    location.origin !== window.__ARSENIC_ORIGIN__
  ) {
    if (_arsenicSwPromise) return _arsenicSwPromise;

    _arsenicSwPromise = new Promise((resolve) => {
      let iframe = document.getElementById('arsenic-sw-frame');
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'arsenic-sw-frame';
        iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;';
        iframe.src = window.__ARSENIC_ORIGIN__ + '/sw-register.html';
        (document.body || document.documentElement).appendChild(iframe);
      }

      const timeout = setTimeout(() => {
        cleanup();
        resolve(); // best-effort
      }, 8000);

      const onMessage = (e) => {
        if (e.data && e.data.type === 'arsenic-sw-ready') {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (iframe && iframe.parentNode) iframe.remove();
      };

      window.addEventListener('message', onMessage);
    });

    return _arsenicSwPromise;
  }

  // Normal direct access to the worker origin
  if (
    location.protocol !== "https:" &&
    !swAllowedHostnames.includes(location.hostname)
  )
    throw new Error("Service workers cannot be registered without https.");

  if (!navigator.serviceWorker)
    throw new Error("Your browser doesn't support service workers.");

  const proxyType = localStorage.getItem('proxy-backend');

  if (proxyType === "dynamic") {
    await navigator.serviceWorker.register("/dynamic.sw.js", {
      scope: "/service/dynamic/",
    });
  } else if (proxyType === "scramjet") {
    await navigator.serviceWorker.register("/scramjet.sw.js", {
      scope: "/service/scramjet/",
    });
  } else {
    await navigator.serviceWorker.register(stockSW, {
      scope: "/service/uv/",
    });
  }
}
