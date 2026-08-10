import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  /*
    The ring needs an offset, and the reason is specific rather than stylistic.

    `--ring` is the same value as `--primary`. Without an offset the focus ring is therefore a
    cyan ring drawn directly on a cyan fill — on every primary button, including the one that
    starts a billable run, focused and unfocused rendered pixel-identical. Two extra classes
    lift it clear of the fill and put a background-coloured gap between, so it reads on the
    primary, destructive, and secondary variants alike. WCAG 2.4.7.
  */
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        // `destructive-solid`, not `destructive`: ice-white on the lighter alert red is 3.40:1.
        // See the token comment in styles.css for why the fill needs its own step.
        destructive:
          "bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90",
        // `interactive`, not `accent`: shadcn's default spends the accent hue on hover, and in
        // this palette that hue is Warning Amber — the colour of `waiting_for_human`, unsaved
        // changes, and the AI Decision node. Every secondary control lighting up in it made
        // amber stop meaning anything. Hover is a surface step here, not a signal.
        outline:
          "border border-input bg-background shadow-sm hover:bg-interactive hover:text-interactive-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-interactive hover:text-interactive-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      /**
       * Sizes carry a coarse-pointer variant rather than a breakpoint.
       *
       * Screen width does not tell you how the control will be touched — a 1280px laptop can
       * have a touchscreen and a tablet can have a trackpad. `pointer-coarse` asks the real
       * question, so every one of these clears 44×44 for a finger and stays compact for a
       * mouse. `sm` also steps up a type size there: 12px is a comfortable label to click and a
       * squint to tap.
       */
      size: {
        default: "h-9 px-4 py-2 pointer-coarse:h-11 pointer-coarse:px-5",
        sm: "h-8 rounded-md px-3 text-xs pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-sm",
        lg: "h-10 rounded-md px-8 pointer-coarse:h-12",
        icon: "h-9 w-9 pointer-coarse:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
