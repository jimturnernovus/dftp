const base = "inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground";

export function Button({ className = "", ...props }) {
  return <button className={`${base} ${className}`} {...props} />;
}

export const buttonClasses = base;
