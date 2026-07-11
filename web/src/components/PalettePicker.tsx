import { useEffect, useRef, useState } from "react";
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
    <label className="flex items-center gap-2 text-[13px] text-ink-muted">
      <span className="w-24 shrink-0">{label}</span>
      <input
        type="color"
        value={paletteValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-8 shrink-0 cursor-pointer rounded-sm border border-hairline bg-transparent p-0"
      />
      <input
        type="text"
        value={textValue}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 rounded-sm border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-ink outline-none transition-colors focus:border-signal"
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
    <div className="rounded-sm border border-hairline bg-surface-2 p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="instrument-label text-ink-faint">
          {baseId ? "Edit palette" : "New palette"}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-ink-muted transition-colors hover:text-ink"
          aria-label="Close editor"
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-muted">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Custom palette"
            className="rounded-sm border border-hairline bg-surface px-2 py-1.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-signal"
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
            className="flex min-h-11 flex-1 items-center justify-center rounded-sm bg-ink text-[12px] font-medium text-ground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex min-h-11 flex-1 items-center justify-center rounded-sm border border-hairline-2 text-[12px] text-ink transition-colors hover:bg-surface"
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
  const editingIdRef = useRef<string | null>(null);

  const selectedPalette = allPalettes[selectedId] ?? allPalettes[defaultPalette];
  const selectedName = allPaletteNames[selectedId] ?? selectedId;
  const isEditingCustom = isCustomPaletteId(selectedId);
  const baseId = isEditingCustom ? selectedId : null;
  const baseName = isEditingCustom ? selectedName : `${selectedName} (custom)`;

  // Track which custom palette id the editor is currently editing.
  if (isOpen && baseId) {
    editingIdRef.current = baseId;
  } else if (!isOpen) {
    editingIdRef.current = null;
  }

  // Close the editor if the custom palette it was editing is deleted.
  useEffect(() => {
    if (isOpen && editingIdRef.current && !allPalettes[editingIdRef.current]) {
      setIsOpen(false);
      editingIdRef.current = null;
    }
  }, [isOpen, allPalettes]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink-muted">Palette</span>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex min-h-9 items-center rounded-sm border border-hairline-2 px-2.5 text-[12px] text-ink transition-colors hover:bg-surface-2"
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
                className={`w-full rounded-sm border p-2 text-left transition-colors ${
                  isSelected
                    ? "border-signal bg-surface-2"
                    : "border-hairline bg-surface hover:border-hairline-2 hover:bg-surface-2"
                }`}
              >
                <div className="flex items-center gap-1 pr-5">
                  <span className={`truncate text-xs ${isSelected ? "text-ink" : "text-ink-muted"}`}>
                    {name}
                  </span>
                  {isCustom && (
                    <span className="instrument-label shrink-0 rounded-sm bg-surface-2 px-1 text-ink-faint">
                      custom
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex gap-1">
                  <div
                    className="h-3 w-3 rounded-sm border border-hairline"
                    style={{ backgroundColor: palette.background }}
                    aria-hidden="true"
                  />
                  <div
                    className="h-3 w-3 rounded-sm border border-hairline"
                    style={{ backgroundColor: palette.foreground }}
                    aria-hidden="true"
                  />
                  <div
                    className="h-3 w-3 rounded-sm border border-hairline"
                    style={{ backgroundColor: palette.accent }}
                    aria-hidden="true"
                  />
                  {palette.water && (
                    <div
                      className="h-3 w-3 rounded-sm border border-hairline"
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
                  className={`absolute right-1 top-1 flex h-6 items-center justify-center rounded-sm text-[12px] transition-colors hover:bg-surface-2 ${
                    deleteConfirmId === id
                      ? "w-auto px-1.5 text-alarm"
                      : "w-6 text-ink-faint hover:text-alarm"
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
