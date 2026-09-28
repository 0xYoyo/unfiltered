/**
 * The design export's StatCard: the metric value in the display serif
 * (readme "Type"), a mono delta, and an optional sparkline whose last bar
 * carries the accent.
 */
const SPARK_HEIGHT = 34;

export function StatCard({
  label,
  value,
  delta,
  trend = "flat",
  note,
  spark,
  tone = "default",
}: {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
  note?: string;
  spark?: number[];
  tone?: "default" | "inverse";
}) {
  const max = spark && spark.length > 0 ? Math.max(...spark) : 1;
  const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : "→";
  return (
    <div
      className={`unf-stat${tone === "default" ? "" : ` unf-stat--${tone}`}`}
    >
      <span className="unf-stat__label">{label}</span>
      <div className="unf-stat__row">
        <span className="unf-stat__value">{value}</span>
        {delta ? (
          <span className={`unf-stat__delta unf-stat__delta--${trend}`}>
            {arrow} {delta}
          </span>
        ) : null}
      </div>
      {spark ? (
        <div className="unf-stat__spark">
          {spark.map((point, index) => (
            <i
              // A sparkline is positional; its index is its identity.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              style={{
                height: `${Math.round((point / max) * SPARK_HEIGHT)}px`,
              }}
            />
          ))}
        </div>
      ) : null}
      {note ? <span className="unf-stat__note">{note}</span> : null}
    </div>
  );
}
