import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchGeocode,
  type GeocodeOutcome,
  type NominatimSearchResult,
} from "../data/geocode.ts";
import { sanitizeSearchQuery } from "./stateSafety.ts";

export type LocationSearchState =
  | { phase: "idle" }
  | { phase: "loading"; query: string }
  | { phase: "success"; message: string }
  | {
      phase: "error";
      kind: "no-results" | "unavailable" | "rate-limited" | "cancelled";
      message: string;
      query: string;
    };

type Searcher = (
  query: string,
  signal?: AbortSignal,
) => Promise<GeocodeOutcome<NominatimSearchResult>>;

function errorState(
  outcome: Exclude<GeocodeOutcome<NominatimSearchResult>, { status: "success" }>,
  query: string,
): LocationSearchState {
  switch (outcome.status) {
    case "no-results":
      return { phase: "error", kind: "no-results", message: "No results. Edit the place name or retry.", query };
    case "rate-limited":
      return { phase: "error", kind: "rate-limited", message: outcome.message, query };
    case "unavailable":
      return { phase: "error", kind: "unavailable", message: outcome.message, query };
    case "cancelled":
      return { phase: "error", kind: "cancelled", message: "Search cancelled.", query };
  }
}

export function useNominatimSearch({
  onResult,
  searcher = searchGeocode,
}: {
  onResult: (result: NominatimSearchResult) => void;
  searcher?: Searcher;
}) {
  const [state, setState] = useState<LocationSearchState>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef("");
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = null;
  }, []);

  const search = useCallback(
    async (rawQuery: string) => {
      const query = sanitizeSearchQuery(rawQuery);
      if (!query) return;
      lastQueryRef.current = query;
      clearSuccessTimer();
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = ++requestIdRef.current;
      setState({ phase: "loading", query });

      const outcome = await searcher(query, controller.signal);
      if (requestId !== requestIdRef.current) return;
      controllerRef.current = null;
      if (outcome.status === "success") {
        onResultRef.current(outcome.value);
        setState({ phase: "success", message: outcome.value.displayName });
        successTimerRef.current = setTimeout(() => {
          setState((current) => (current.phase === "success" ? { phase: "idle" } : current));
          successTimerRef.current = null;
        }, 5_000);
        return;
      }
      setState(errorState(outcome, query));
    },
    [clearSuccessTimer, searcher],
  );

  const retry = useCallback(() => {
    if (lastQueryRef.current) void search(lastQueryRef.current);
  }, [search]);

  const dismiss = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    clearSuccessTimer();
    setState({ phase: "idle" });
  }, [clearSuccessTimer]);

  const cancel = useCallback(() => {
    const query = lastQueryRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    clearSuccessTimer();
    setState({ phase: "error", kind: "cancelled", message: "Search cancelled.", query });
  }, [clearSuccessTimer]);

  /** Editing is the explicit dismissal boundary for persistent search errors. */
  const edited = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    clearSuccessTimer();
    setState({ phase: "idle" });
  }, [clearSuccessTimer]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      requestIdRef.current += 1;
      clearSuccessTimer();
    },
    [clearSuccessTimer],
  );

  return { state, search, retry, dismiss, cancel, edited };
}
