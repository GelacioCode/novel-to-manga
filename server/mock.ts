import type { Adaptation } from "./schemas";

export function splitPassages(sourceText: string) {
  return sourceText.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).map((text, i) => ({ id: `p${i + 1}`, text }));
}

export function mockAdaptation(sourceText: string, totalPages: number, mode: "faithful" | "condensed"): Adaptation {
  const passages = splitPassages(sourceText);
  const chosen = passages.length ? passages : [{ id: "p1", text: sourceText }];
  return {
    passages: chosen,
    events: chosen.map((p, i) => ({ id: `event-${i + 1}`, summary: p.text.slice(0, 160), passageIds: [p.id] })),
    characters: [{ name: "Unidentified protagonist", role: "Detected from source in mock mode", inferredDesign: true }],
    locations: ["Location to review"],
    continuityChanges: [],
    pages: Array.from({ length: totalPages }, (_, i) => {
      const passage = chosen[i % chosen.length];
      return { pageNumber: i + 1, panels: [{ sourcePassageIds: [passage.id], description: `${mode} adaptation placeholder: ${passage.text.slice(0, 120)}`, dialogue: [{ speaker: "Narrator", text: passage.text.slice(0, 110) }] }] };
    })
  };
}

export function mockSvg(title: string, pageNumber: number, panelText: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1300" viewBox="0 0 900 1300">
  <rect width="900" height="1300" fill="#f7f4eb"/><rect x="36" y="36" width="828" height="1228" rx="4" fill="#fff" stroke="#171717" stroke-width="8"/>
  <path d="M60 300 L840 90 M60 650 L840 430 M60 1010 L840 790" stroke="#d3d0c7" stroke-width="3"/>
  <rect x="88" y="110" width="724" height="140" rx="70" fill="#fff" stroke="#111" stroke-width="5"/>
  <text x="450" y="165" text-anchor="middle" font-family="Georgia,serif" font-size="30" font-weight="700">MOCK ARTWORK · PAGE ${pageNumber}</text>
  <text x="450" y="210" text-anchor="middle" font-family="Arial,sans-serif" font-size="18">No external image provider was called</text>
  <circle cx="290" cy="610" r="120" fill="#eee" stroke="#111" stroke-width="7"/><circle cx="610" cy="610" r="120" fill="#ddd" stroke="#111" stroke-width="7"/>
  <path d="M150 1050 Q450 760 750 1050" fill="none" stroke="#111" stroke-width="10"/>
  <text x="80" y="1175" font-family="Arial,sans-serif" font-size="23">${esc(panelText.slice(0, 62))}</text>
  <text x="80" y="1220" font-family="Georgia,serif" font-size="18">${esc(title)}</text></svg>`;
}
