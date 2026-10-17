/* Small helpers shared by the framework, the library and the tests. */
(function (root) {
  'use strict';
  const I = {
    int: (k, l, d, min = 1, max = 1000) => ({ k, l, t: 'int', d, min, max }),
    float: (k, l, d, min = 0, max = 100, step = 0.1) => ({ k, l, t: 'float', d, min, max, step }),
    color: (k, l, d) => ({ k, l, t: 'color', d }),
    select: (k, l, d, opts) => ({ k, l, t: 'select', d, opts }),
    bool: (k, l, d) => ({ k, l, t: 'bool', d }),
  };
  const SRC = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
  const hexA = (hex, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  const kit = { I, SRC, hexA };
  if (typeof module !== 'undefined' && module.exports) module.exports = kit; else root.JGKIT = kit;
})(typeof window !== 'undefined' ? window : globalThis);
