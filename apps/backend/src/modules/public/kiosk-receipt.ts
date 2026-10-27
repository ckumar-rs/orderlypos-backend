export function kioskReceiptText(input: {
  restaurant: string;
  orderNumber: string;
  lines: { quantity: number; name: string; lineTotal: string }[];
  total: string;
  paid: boolean;
}): string {
  const status = input.paid ? "PAID RECEIPT" : "NOT PAID RECEIPT";
  const lines = input.lines.map(
    (line) => `${line.quantity} x ${line.name} — ${line.lineTotal}`,
  );
  return [
    input.restaurant,
    status,
    `Order ${input.orderNumber}`,
    ...lines,
    `Total ${input.total}`,
    input.paid
      ? "This order is paid."
      : "This order is not paid. Pay at the counter.",
  ].join("\n");
}
