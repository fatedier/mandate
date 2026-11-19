/** Whether there is an entry for this page of the folder, by its path there:
 *  its own key, never one every object has (such as "constructor"). */
export function hasPage(pages: Record<string, unknown>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(pages, path);
}
