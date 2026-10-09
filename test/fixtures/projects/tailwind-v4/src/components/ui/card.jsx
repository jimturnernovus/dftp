export const Card = ({ className = "", ...props }) => (
  <div className={`rounded-lg border bg-background p-6 ${className}`} {...props} />
);

export const CardTitle = ({ className = "", ...props }) => (
  <h3 className={`text-lg ${className}`} {...props} />
);
