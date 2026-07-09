import { useEffect, useState } from "react";
import type { Palette } from "../engine/types.ts";
import { isCustomPaletteId } from "../presets/customPalettes.ts";
import { defaultPalette } from "../presets/palettes.ts";

type Props = {
  selectedId: string;
  allPalettes: Record<string, Palette>;
  allPaletteNames: Record<string, string>;
  onSelect: (id: string) => void;
  onSavePalette: (id: string, name: string, palette: Palette) => void;
  onDeletePalette: (id: string) => void;
};

type ColorKey = "background" | "foreground" | "accent" | "water" | "ocean" | "lake" | "river";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COLOR_ROWS: { key: ColorKey; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Linework" },
  { key: "accent", label: "Accent" },
  { key: "water", label: "Water" },
  { key: "ocean", label: "Ocean" },
  { key: "lake", label: "Lake" },
  { key: "river", label: "River" },
];

function isValidHex(value: string): boolean {
  return HEX_RE.test(value);
}

function fillPalette(palette: Palette): Record<ColorKey, string> {
  const water = palette.water ?? palette.accent;
  return {
    background: palette.background,
    foreground: palette.foreground,
    accent: palette.accent,
    water,
    ocean: palette.ocean ?? water,
    lake: palette.lake ?? water,
    river: palette.river ?? water,
  };
}

function ColorRow({
  label,
  paletteValue,
  textValue,
  onChange,
}: {
  label: string;
  paletteValue: string;
  textValue: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-white/80">
      <span className="w-24 shrink-0">{label}</span>
      <input
        type="color"
        value={paletteValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-8 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent p-0"
      />
      <input
        type="text"
        value={textValue}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1.5 font-mono text-sm outline-none focus:border-white/30"
      />
    </label>
  );
}

function PaletteEditor({
  baseName,
  basePalette,
  baseId,
  onSave,
  onCancel,
}: {
  baseName: string;
  basePalette: Palette;
  baseId: string | null;
  onSave: (id: string, name: string, palette: Palette) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(baseName);
  const [palette, setPalette] = useState<Record<ColorKey, string>>(fillPalette(basePalette));
  const [draft, setDraft] = useState<Record<ColorKey, string>>(fillPalette(basePalette));

  useEffect(() => {
    setName(baseName);
    const filled = fillPalette(basePalette);
    setPalette(filled);
    setDraft(filled);
  }, [baseName, basePalette]);

  const handleColorChange = (key: ColorKey, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (isValidHex(value)) {
      setPalette((prev) => ({ ...prev, [key]: value.toLowerCase() }));
    }
  };

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = baseId ?? `custom-${Date.now().toString(36)}`;
    onSave(id, trimmed, palette as Palette);
  };

  return (
    <div className="rounded border border-white/10 bg-white/5 p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-white/40">
          {baseId ? "Edit palette" : "New palette"}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-white/50 hover:text-white"
          aria-label="Close editor"
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-sm text-white/80">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Custom palette"
            className="rounded border border-white/10 bg-white/5 px-2 py-1.5 text-sm outline-none focus:border-white/30"
          />
        </label>

        {COLOR_ROWS.map(({ key, label }) => (
          <ColorRow
            key={key}
            label={label}
            paletteValue={palette[key]}
            textValue={draft[key]}
            onChange={(value) => handleColorChange(key, value)}
          />
        ))}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim()}
            className="flex-1 rounded bg-white py-2 text-xs font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded border border-white/20 py-2 text-xs transition-colors hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function PalettePicker({
  selectedId,
  allPalettes,
  allPaletteNames,
  onSelect,
  onSavePalette,
  onDeletePalette,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const selectedPalette = allPalettes[selectedId] ?? allPalettes[defaultPalette];
  const selectedName = allPaletteNames[selectedId] ?? selectedId;
  const isEditingCustom = isCustomPaletteId(selectedId);
  const baseId = isEditingCustom ? selectedId : null;
  const baseName = isEditingCustom ? selectedName : `${selectedName} (custom)`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-white/80">Palette</span>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="rounded border border-white/20 px-2 py-1 text-xs transition-colors hover:bg-white/10"
        >
          {isOpen ? "Close" : baseId ? "Edit palette" : "New palette"}
        </button>
      </div>

      {isOpen && (
        <PaletteEditor
          baseName={baseName}
          basePalette={selectedPalette}
          baseId={baseId}
          onSave={(id, name, palette) => {
            onSavePalette(id, name, palette);
            setIsOpen(false);
          }}
          onCancel={() => setIsOpen(false)}
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        {Object.keys(allPalettes).map((id) => {
          const palette = allPalettes[id];
          const name = allPaletteNames[id] ?? id;
          const isCustom = isCustomPaletteId(id);
          const isSelected = id === selectedId;
          return (
            <div key={id} className="relative">
              <button
                type="button"
                onClick={() => {
                  onSelect(id);
                  setDeleteConfirmId(null);
                }}
                aria-pressed={isSelected}
                className={`w-full rounded border p-2 text-left transition-colors ${
                  isSelected
                    ? "border-white/60 bg-white/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center gap-1 pr-5">
                  <span className="truncate text-xs">{name}</span>
                  {isCustom && (
                    <span className="shrink-0 rounded bg-white/10 px-1 text-[10px] text-white/50">
                      custom
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex gap-1">
                  <div
                    className="h-3 w-3 rounded-sm border border-white/10"
                    style={{ backgroundColor: palette.background }}
                    aria-hidden="true"
                  />
                  <div
                    className="h-3 w-3 rounded-sm border border-white/10"
                    style={{ backgroundColor: palette.foreground }}
                    aria-hidden="true"
                  />
                  <div
                    className="h-3 w-3 rounded-sm border border-white/10"
                    style={{ backgroundColor: palette.accent }}
                    aria-hidden="true"
                  />
                  {palette.water && (
                    <div
                      className="h-3 w-3 rounded-sm border border-white/10"
                      style={{ backgroundColor: palette.water }}
                      aria-hidden="true"
                    />
                  )}
                </div>
              </button>
              {isCustom && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (deleteConfirmId === id) {
                      onDeletePalette(id);
                      setDeleteConfirmId(null);
                    } else {
                      setDeleteConfirmId(id);
                    }
                  }}
                  className={`absolute right-1 top-1 flex h-5 items-center justify-center rounded text-[10px] text-white/50 hover:bg-white/10 hover:text-white ${
                    deleteConfirmId === id ? "w-auto px-1.5" : "w-5"
                  }`}
                  aria-label={deleteConfirmId === id ? "Confirm delete" : "Delete palette"}
                >
                  {deleteConfirmId === id ? "Delete?" : "×"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
