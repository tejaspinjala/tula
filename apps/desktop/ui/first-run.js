document.getElementById('address').focus()
document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    // The IPC bridge Tauri injects into every webview; pages get no global API object.
    await window.__TAURI_INTERNALS__.invoke('set_server_url', {
      address: document.getElementById('address').value,
    })
  } catch (error) {
    document.getElementById('error').textContent = String(error)
  }
})
