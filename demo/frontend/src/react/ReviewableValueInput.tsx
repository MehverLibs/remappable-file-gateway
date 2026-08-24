/**
 * An editable table value with a keyboard-accessible full-value preview.
 * Table cells may deliberately stay compact; the preview prevents clipping
 * from hiding a path or filename during pre-save review.
 */

interface ReviewableValueInputProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly invalid?: boolean;
  readonly onChange: (value: string) => void;
}

export function ReviewableValueInput({
  id,
  label,
  value,
  invalid = false,
  onChange,
}: ReviewableValueInputProps) {
  const previewId = `${id}-complete-value`;
  return (
    <span className="reviewable-value">
      <input
        className={invalid ? "invalid" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={`${label}：${value || "（空）"}`}
        aria-describedby={previewId}
        title={value || "（空）"}
        spellCheck={false}
      />
      <span id={previewId} className="value-popover" role="tooltip">
        <span className="value-popover-label">{label}（完整值）</span>
        {value || "（空）"}
      </span>
    </span>
  );
}
