import type { PublicWebsite } from '@chatflow/types';

interface WebsiteListProps {
  websites: PublicWebsite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function WebsiteList({ websites, selectedId, onSelect }: WebsiteListProps) {
  return (
    <nav aria-label="Websites" className="p-2">
      <h2 className="px-2 pt-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Websites
      </h2>
      {websites.length === 0 ? (
        <p className="px-2 py-2 text-sm text-slate-500">No websites available.</p>
      ) : (
        <ul className="space-y-1">
          {websites.map((website) => {
            const selected = website.id === selectedId;
            return (
              <li key={website.id}>
                <button
                  type="button"
                  onClick={() => onSelect(website.id)}
                  aria-pressed={selected}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm ${
                    selected ? 'bg-slate-100 ring-1 ring-slate-300' : 'hover:bg-slate-50'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-800">
                      {website.name}
                    </span>
                    <span className="block truncate text-xs text-slate-400">{website.domain}</span>
                  </span>
                  <span className="ml-2 flex shrink-0 flex-col items-end gap-1">
                    {website.aiEnabled && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600">
                        AI
                      </span>
                    )}
                    {!website.isActive && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        Deactivated
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
