'use client';
import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type ComponentProps,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Command } from 'cmdk';
import { Check, ChevronDown, Search } from 'lucide-react';
export { AsyncButton as Button } from '@/components/dashboard/AsyncButton';

// Owned, shadcn-style Radix compositions. Native prop adapters preserve existing form contracts.
export function Input(props: ComponentProps<'input'>) {
  if (props.type === 'checkbox') return <Checkbox {...props} />;
  return <input {...props} className={`ui-input ${props.className || ''}`} />;
}
export function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`ui-textarea ${props.className || ''}`} />;
}
export function Checkbox({ checked, defaultChecked, onChange, ...props }: ComponentProps<'input'>) {
  return (
    <CheckboxPrimitive.Root
      {...{
        name: props.name,
        id: props.id,
        required: props.required,
        disabled: props.disabled,
        value: props.value as string,
        'aria-label': props['aria-label'],
      }}
      className={`ui-checkbox ${props.className || ''}`}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(value) =>
        onChange?.({
          target: { checked: value === true },
          currentTarget: { checked: value === true },
        } as ChangeEvent<HTMLInputElement>)
      }
    >
      <CheckboxPrimitive.Indicator>
        <Check size={12} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <SwitchPrimitive.Root
      className="ui-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
    >
      <SwitchPrimitive.Thumb />
    </SwitchPrimitive.Root>
  );
}
const EMPTY = '__creator_hub_empty_option__';
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  className,
  ...props
}: ComponentProps<'select'>) {
  function readOptions(
    nodes: ReactNode
  ): { value: string; label: ReactNode; disabled?: boolean }[] {
    return Children.toArray(nodes).flatMap((node) => {
      if (!isValidElement(node)) return [];
      const p = node.props as { value: string; children: ReactNode; disabled?: boolean };
      if (node.type === Fragment || node.type === 'optgroup') return readOptions(p.children);
      return [{ value: String(p.value ?? ''), label: p.children, disabled: p.disabled }];
    });
  }
  const options = readOptions(children);
  const [localValue, setLocalValue] = useState(String(defaultValue ?? options[0]?.value ?? ''));
  const [open, setOpen] = useState(false);
  const selected = String(value ?? localValue);
  const change = (next: string) => {
    const actual = next === EMPTY ? '' : next;
    setLocalValue(actual);
    onChange?.({
      target: { value: actual },
      currentTarget: { value: actual },
    } as ChangeEvent<HTMLSelectElement>);
    setOpen(false);
  };
  const triggerProps = {
    id: props.id,
    disabled: props.disabled,
    'aria-label': props['aria-label'],
    'aria-required': props.required,
    className: `ui-select-trigger ${className || ''}`,
  };
  // Searchable entity lists use the same portal, keyboard, collision and focus behavior as other controls.
  if (options.length > 7)
    return (
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        {props.name && <input type="hidden" name={props.name} value={selected} />}
        <PopoverPrimitive.Trigger {...triggerProps} role="combobox" aria-expanded={open}>
          <span>{options.find((o) => o.value === selected)?.label || 'Choose…'}</span>
          <ChevronDown size={14} />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            className="ui-popover"
            sideOffset={5}
            collisionPadding={12}
            align="start"
          >
            <Command>
              <div className="ui-command-search">
                <Search size={14} />
                <Command.Input aria-label="Search options" placeholder="Search…" />
              </div>
              <Command.List>
                <Command.Empty>No matches.</Command.Empty>
                {options.map((o) => (
                  <Command.Item
                    key={o.value || EMPTY}
                    value={`${o.value} ${String(o.label)}`}
                    disabled={o.disabled}
                    onSelect={() => change(o.value)}
                  >
                    <span>{o.label}</span>
                    {selected === o.value && <Check size={14} />}
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    );
  return (
    <>
      <input type="hidden" name={props.name} value={selected} />
      <SelectPrimitive.Root
        required={props.required}
        disabled={props.disabled}
        value={selected || EMPTY}
        onValueChange={change}
      >
        <SelectPrimitive.Trigger {...triggerProps}>
          <SelectPrimitive.Value>
            {options.find((o) => o.value === selected)?.label || 'Choose…'}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon>
            <ChevronDown size={14} />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            className="ui-select-content"
            position="popper"
            sideOffset={5}
            collisionPadding={12}
          >
            <SelectPrimitive.ScrollUpButton className="ui-scroll">↑</SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport>
              {options.map((o) => (
                <SelectPrimitive.Item
                  className="ui-select-item"
                  key={o.value || EMPTY}
                  value={o.value || EMPTY}
                  disabled={o.disabled}
                >
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Check size={14} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="ui-scroll">
              ↓
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </>
  );
}
export function DropdownMenu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content className="ui-menu" sideOffset={6} align="end" collisionPadding={12}>
          {children}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
export function DropdownItem({
  children,
  onSelect,
  destructive,
}: {
  children: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      className={`ui-menu-item ${destructive ? 'danger-text' : ''}`}
      onSelect={onSelect}
    >
      {children}
    </MenuPrimitive.Item>
  );
}
export function Tooltip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="ui-tooltip" sideOffset={6} collisionPadding={10}>
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
