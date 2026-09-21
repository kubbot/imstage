// Shared browser-only layout pass for preview and evaluation exports.
export function fitDocumentText() {
    const MIN = 12;
    const results = [];
    const patches = Array.from(document.querySelectorAll('[data-text-patch]'));
    for (const patch of patches) {
      const inner = patch.querySelector('.patch-text');
      let size = Number(patch.dataset.fontSize) || 16;
      let overflow = 0;
      for (;;) {
        inner.style.fontSize = `${size}px`;
        // Reading scroll/client forces a layout with the new font size.
        const vertical = patch.scrollHeight - patch.clientHeight;
        const horizontal = patch.scrollWidth - patch.clientWidth;
        overflow = Math.max(0, vertical, horizontal);
        if (overflow <= 0.5 || size <= MIN) break;
        size -= 1;
      }
      results.push({
        id: patch.dataset.editId,
        fits: overflow <= 1,
        fontSize: size,
        overflowPx: Math.ceil(overflow),
      });
    }
    return results;
}
