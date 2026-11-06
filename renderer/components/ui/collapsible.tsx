import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';

// Radix collapsible primitives — no wrapper styling (the prompt-kit
// chain-of-thought / tool components own their chrome). Animations:
// `.animate-collapsible-down/up` in globals.css.
const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

const CollapsibleContent = CollapsiblePrimitive.Content;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };