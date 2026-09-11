import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  // `cursor-pointer` is not decoration: Tailwind v4 dropped the preflight
  // `button { cursor: pointer }`, so without it every control in the cockpit —
  // Approve, Deny, Dismiss, the tabs — renders an arrow. It is invisible in a
  // screenshot, which is exactly why a screenshot-driven review misses it.
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Hover goes DARKER, not thinner. The shipped `hover:bg-primary/80`
        // thinned the fill toward the card behind it, which reads as the button
        // becoming disabled — and it dropped the button's own label to 2.91:1,
        // below AA, on the single most important control in the product. The
        // `secondary` variant below already uses this `color-mix` idiom.
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),black_12%)] dark:hover:bg-[color-mix(in_oklch,var(--primary),white_12%)]",
        outline:
          "border-border bg-background hover:bg-hover-overlay hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        // An overlay, not `muted`: a ghost button sits on `card`, on `muted`
        // and on `background` in different places, and `hover:bg-muted` on a
        // card footer that is itself `muted` measured 1.00:1 — no hover at all
        // on the card's escape to a freeform answer.
        ghost:
          "hover:bg-hover-overlay hover:text-foreground aria-expanded:bg-hover-overlay aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-lg px-2 text-meta has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        // `sm` is the quiet secondary action: a card's "Show more", "Write a
        // reply instead" and "Dismiss". Three corrections to the shipped
        // default, so those three stop reading as a different kit from the
        // option buttons beside them — `min(var(--radius-md),12px)` resolved to
        // 8px against every neighbour's 10px, `text-xs` is 12px and off the
        // five-step scale, and `h-7` is a 28px tap target on a phone-first
        // surface where the utility icon beside it gets 44px.
        sm: "h-7 gap-1 rounded-lg px-2.5 text-ui pointer-coarse:h-11 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        // Phone-first: 44px clears the iOS touch minimum, then relaxes to the
        // `lg` box once there is a pointer. For the controls a tap must hit.
        touch: "h-11 gap-1.5 px-3.5 text-ui sm:h-9 sm:px-2.5",
        "icon-touch": "size-11 sm:size-8",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
