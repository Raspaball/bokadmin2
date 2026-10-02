// src/app/utils/download.ts
// Last ned en tekst som fil i nettleseren. Brukt av TilgjengelighetTab.tsx
// (statusrapporten) og JobHealth.tsx (logg per jobb).

export function downloadCsv(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
