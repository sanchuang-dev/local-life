export type FilterOption = {
  value: string
  label: string
}

/**
 * Horizontally scrollable single-select chips. Values are plain strings so list
 * pages can bind them directly to contracted enum values; selection is also
 * conveyed with `aria-pressed`, not colour alone.
 */
export function FilterChipRow({
  label,
  options,
  value,
  onChange,
  allLabel = '全部',
}: {
  label: string
  options: FilterOption[]
  value: string
  onChange: (value: string) => void
  allLabel?: string
}) {
  const choices = [{ value: '', label: allLabel }, ...options]
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-slate-400">{label}</p>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {choices.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value || 'all'}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={`min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                selected
                  ? 'border-teal-600 bg-teal-600 text-white'
                  : 'border-slate-200 bg-white text-slate-500'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
