import type { HistoryQuery } from "../../api/types";
import type { ResultDetailsFilter } from "../results/ResultDetailsDialog";
import { validateHistoryFilters } from "./HistoryFilters";

export function mergeResultDetailsFilter(query: HistoryQuery, filter: ResultDetailsFilter): HistoryQuery {
  const filters = { ...query.filters, ...filter };
  if ("parameters" in filter) {
    const entry = filter.parameters[0];
    filters.parameters = [...(query.filters?.parameters ?? []).filter(
      (parameter) => parameter.key !== entry.key || parameter.value_type !== entry.value_type,
    ), entry];
  } else if ("image_inputs" in filter) {
    const entry = filter.image_inputs[0];
    filters.image_inputs = [...(query.filters?.image_inputs ?? []).filter(
      (input) => input.slot_key !== entry.slot_key,
    ), entry];
  }
  const validation = validateHistoryFilters(filters);
  if (validation) throw new Error(`${validation} Close Details to edit Gallery filters, then try again.`);
  return { ...query, filters, cursor: null };
}
