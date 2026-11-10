'use client';
import { AsyncButton } from './AsyncButton';
import { Select } from '@/components/ui/controls';
export function Pagination({
  page,
  pageSize,
  total,
  busy,
  onPage,
  onSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  busy?: boolean;
  onPage: (page: number) => void;
  onSize?: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>
        {total
          ? `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`
          : '0 posts'}
      </span>
      <div className="pagination-actions">
        {onSize && (
          <Select
            aria-label="Posts per page"
            value={String(pageSize)}
            disabled={busy}
            onChange={(e) => onSize(Number(e.target.value))}
          >
            {[12, 24, 48].map((n) => (
              <option key={n} value={n}>
                {n} per page
              </option>
            ))}
          </Select>
        )}
        <AsyncButton
          type="button"
          className="button"
          disabled={busy || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </AsyncButton>
        <span>
          Page {page} of {pages}
        </span>
        <AsyncButton
          type="button"
          className="button"
          disabled={busy || page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </AsyncButton>
      </div>
    </div>
  );
}
