import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LocaleId } from "../../../../shared/contracts.ts";
import { UiIcon } from "../../components/UiIcon";
import { fill, usageText } from "./usageText.ts";

/** Paginate the existing report flow instead of clipping rows or adding a scroll area. */
export function UsageHistoryPages({ children, locale }: { children: ReactNode; locale: LocaleId }): React.JSX.Element {
  const flowRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const text = usageText(locale);
  const currentPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const measure = (): void => {
      if (flow.clientWidth === 0) return;
      const count = Math.max(1, Math.ceil((flow.scrollWidth - 1) / flow.clientWidth));
      setPageCount(count);
      setPage((current) => Math.min(current, count - 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(flow);
    flow.addEventListener("toggle", measure, true);
    return () => {
      observer.disconnect();
      flow.removeEventListener("toggle", measure, true);
    };
  }, [children]);

  return (
    <div className="usage-history__pages">
      <div className="usage-history__page-viewport">
        <div
          ref={flowRef}
          className="usage-history__page-flow"
          style={{ transform: `translateX(-${currentPage * 100}%)` }}
          onFocusCapture={(event) => {
            const flow = flowRef.current;
            if (!flow || flow.clientWidth === 0) return;
            const offset = event.target.getBoundingClientRect().left - flow.getBoundingClientRect().left;
            setPage(Math.max(0, Math.min(pageCount - 1, Math.floor((offset + 1) / flow.clientWidth))));
          }}
        >
          {children}
        </div>
      </div>
      <footer className="usage-history__pagination">
        {pageCount > 1 && <>
          <button type="button" className="usage-history__previous" aria-label={text.previousPage} title={text.previousPage}
            disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            <UiIcon name="arrow" size="1.15em" />
          </button>
          <span role="status">{fill(text.page, { current: currentPage + 1, total: pageCount })}</span>
          <button type="button" aria-label={text.nextPage} title={text.nextPage}
            disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>
            <UiIcon name="arrow" size="1.15em" />
          </button>
        </>}
      </footer>
    </div>
  );
}
