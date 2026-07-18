const formatted = new Intl.NumberFormat('fr-FR', {
  useGrouping: false,
  minimumFractionDigits: 1,
}).format(1.5);

if (formatted !== '1,5') {
  throw new Error(`unexpected French number formatting: ${formatted}`);
}

if ('e\u0301'.normalize('NFC') !== 'é') {
  throw new Error('Unicode normalization failed');
}

console.log('icu fallback passed');
