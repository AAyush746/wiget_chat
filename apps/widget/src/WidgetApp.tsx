export function WidgetApp({ websiteId }: { websiteId: string }) {
  return (
    <div className="fixed bottom-4 right-4 z-[2147483647] flex flex-col items-end gap-3 font-sans">
      <div className="w-64 rounded-xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl">
        <p className="text-sm font-semibold">ChatFlow</p>
        <p className="mt-1 text-xs text-slate-500">
          Website: <span className="font-mono">{websiteId}</span>
        </p>
      </div>
      <button
        type="button"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white shadow-lg transition hover:bg-indigo-500"
      >
        Chat
      </button>
    </div>
  );
}
