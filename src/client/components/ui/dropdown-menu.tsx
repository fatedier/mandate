import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { Check } from "lucide-react"
import { useComposedRefs } from "radix-ui/internal"

import { cn } from "@/lib/utils"
import { CloseRequests } from "@/lib/close-requests"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  onCloseAutoFocus,
  onKeyDownCapture,
  onPointerDownCapture,
  onEscapeKeyDown,
  onPointerDownOutside,
  ref,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  // Whether the open menu was last used from the keyboard.
  const fromKeyboard = React.useRef(false)
  const own = React.useRef<HTMLDivElement>(null)
  const refs = useComposedRefs(own, ref)
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={refs}
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        // A press on the menu's own button is the button's: it opens or
        // shuts the menu (as Radix's popover has it). Left to the layer, a
        // press there while the menu fades out, shut by one of its items,
        // opened it again and was then taken for a press outside, which shut
        // it at once. The content names its button (aria-labelledby).
        onPointerDownOutside={(event) => {
          const button = own.current?.getAttribute("aria-labelledby")
          if (button && document.getElementById(button)?.contains(event.target as Node)) event.preventDefault()
          onPointerDownOutside?.(event)
        }}
        // Radix calls .focus() on the trigger when the menu closes; Chrome's
        // focus-visible heuristic flags that programmatic focus as
        // keyboard-style, so after a click a focus ring lingers on the
        // trigger until the user clicks elsewhere a second time. So focus
        // goes back only to a menu last used from the keyboard (Esc, Enter
        // on an item), where the ring is wanted and the next Tab carries on
        // from the trigger rather than from the top of the page. Callers
        // can pass their own onCloseAutoFocus.
        onKeyDownCapture={(event) => {
          fromKeyboard.current = true
          onKeyDownCapture?.(event)
        }}
        // Heard on the document: an Esc pressed before the menu has moved
        // focus into itself lands on the trigger, outside the content.
        onEscapeKeyDown={(event) => {
          fromKeyboard.current = true
          onEscapeKeyDown?.(event)
        }}
        onPointerDownCapture={(event) => {
          fromKeyboard.current = false
          onPointerDownCapture?.(event)
        }}
        onCloseAutoFocus={onCloseAutoFocus ?? ((event) => {
          const keyboard = fromKeyboard.current
          fromKeyboard.current = false
          if (!keyboard) event.preventDefault()
        })}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      >
        <CloseRequests />
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 outline-hidden select-none focus:bg-sel focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
        className
      )}
      {...props}
    />
  )
}

/** One choice among several: its items show which one holds. */
function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

/** A choice in a radio group: an item, with a check where it holds. */
function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm pointer-coarse:min-h-11 outline-hidden select-none focus:bg-sel focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

/** A group's heading inside a menu: names the items under it, not one itself. */
function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2 pt-2 pb-1 text-2xs font-semibold text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
}
