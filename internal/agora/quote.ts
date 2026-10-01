/** A message's own words for a one-line preview: the quotes it opens with (`> ` blocks) left out, when anything follows them. */
export const unquoted = (text: string): string => {
  const rest = text.replace(/^(?:[ \t]*>[^\n]*(?:\n|$)|[ \t]*\n)+/, "");
  return rest.trim() ? rest : text;
};
