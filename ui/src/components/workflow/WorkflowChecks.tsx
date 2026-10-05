import { CheckIcon, CircleAlertIcon, XIcon } from "lucide-react";
import type { WorkflowCheck } from "@agora/workflow-types";
import { cn } from "@/lib/utils";

function Result({ status }: { status: WorkflowCheck["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-meta",
        status === "passed"
          ? "bg-human-soft text-human"
          : status === "failed"
            ? "bg-destructive-soft text-destructive"
            : "bg-amber-soft text-amber-ink",
      )}
    >
      {status === "passed" ? (
        <CheckIcon aria-hidden className="size-3" />
      ) : status === "failed" ? (
        <XIcon aria-hidden className="size-3" />
      ) : (
        <CircleAlertIcon aria-hidden className="size-3" />
      )}
      {status}
    </span>
  );
}

export function WorkflowChecks({ checks }: { checks: WorkflowCheck[] }) {
  return (
    <div className="@container/checks min-w-0">
      <ol
        aria-label="Criteria and evidence"
        className="m-0 list-none divide-y divide-border/60 p-0 @min-[36rem]/checks:hidden"
      >
        {checks.map((check, i) => (
          <li
            key={`${check.criterion}-${i}`}
            className="min-w-0 py-4 first:pt-0 last:pb-0"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-meta font-medium text-faint">
                Criterion {String(i + 1).padStart(2, "0")}
              </span>
              <Result status={check.status} />
            </div>
            <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {check.criterion}
            </p>
            <dl className="mt-3">
              <dt className="text-meta text-faint">Evidence / method</dt>
              <dd className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {check.evidence}
              </dd>
            </dl>
          </li>
        ))}
      </ol>
      <table className="hidden w-full table-fixed text-left text-sm @min-[36rem]/checks:table">
        <caption className="sr-only">Criteria, results, and evidence</caption>
        <colgroup>
          <col className="w-[32%]" />
          <col className="w-[18%]" />
          <col className="w-[50%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border text-meta text-faint">
            <th scope="col" className="pb-2 pr-4 font-medium">
              Criterion
            </th>
            <th scope="col" className="pb-2 pr-4 font-medium">
              Result
            </th>
            <th scope="col" className="pb-2 font-medium">
              Evidence / method
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check, i) => (
            <tr
              key={`${check.criterion}-${i}`}
              className="border-b border-border/60 last:border-0"
            >
              <th
                scope="row"
                className="py-3 pr-4 align-top font-medium leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {check.criterion}
              </th>
              <td className="py-3 pr-4 align-top">
                <Result status={check.status} />
              </td>
              <td className="py-3 align-top leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {check.evidence}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
