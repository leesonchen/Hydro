// Hydro disables YAML formatting; keep the worker's optional import compatible.
export async function format(source: string): Promise<string> {
  return source;
}
