document.getElementById('address').focus()
document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    // The IPC bridge Tauri injects into every webview; pages get no global API object.
    await window.__TAURI_INTERNALS__.invoke('set_server_url', {
      address: document.getElementById('address').value,
    })
  } catch (error) {
    // Rust validation messages arrive as strings; anything else is a raw JS error the Guild Master should not see.
    document.getElementById('error').textContent =
      typeof error === 'string'
        ? error
        : 'The Guildhall could not be reached from here. Check the address and try again.'
  }
})
