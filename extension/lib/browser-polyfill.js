// Simple polyfill: map chrome.* to browser.* style
if (typeof browser === 'undefined') {
    window.browser = chrome;
}
