import { useLocation } from "react-router";
import { RouteDialog } from "@/components/RouteDialog";
import { useRouteDialogClose } from "@/components/route-dialog-close";
import { StateMessage } from "@/components/ViewState";
import { CloseRequests } from "@/lib/close-requests";
import { fileNameOf, fileTargetOfSearch } from "@/lib/file-link";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { FileView } from "./FileView";

/** A file's own page: a direct visit to `/file?path=…`, or a link opened in a
 *  new browser tab. */
export function FilePage() {
  const target = fileTargetOfSearch(useLocation().search);
  if (!target) return <StateMessage title="File not found">It may have been moved or deleted.</StateMessage>;
  return (
    <>
      <PaneHeaderTitle>{fileNameOf(target.path)}</PaneHeaderTitle>
      <FileView key={target.path} target={target} presentation="page" />
    </>
  );
}

/** A file over whatever it was opened from (a phone, a page without a
 *  panel); Back or its close button returns there. */
export function FileModal() {
  return (
    <RouteDialog label="File">
      <CloseRequests />
      <ModalFile />
    </RouteDialog>
  );
}

function ModalFile() {
  const target = fileTargetOfSearch(useLocation().search);
  const close = useRouteDialogClose() ?? undefined;
  if (!target) return <StateMessage title="File not found">It may have been moved or deleted.</StateMessage>;
  return <FileView key={target.path} target={target} presentation="dialog" onClose={close} />;
}
