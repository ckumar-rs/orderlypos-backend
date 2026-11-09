import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
  let totalAssigned = 0;
  for (const branch of branches) {
    const items = await prisma.menuItem.findMany({
      where: { branchId: branch.id },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: { id: true, sku: true },
    });
    const taken = new Set(
      items
        .map((item) => item.sku?.trim().toUpperCase())
        .filter((sku): sku is string => Boolean(sku)),
    );
    let assigned = 0;
    for (const item of items) {
      if (item.sku?.trim()) continue;
      let n = 1;
      let sku = '';
      while (n < 100_000) {
        const candidate = `MI-${String(n).padStart(4, '0')}`;
        if (!taken.has(candidate)) {
          sku = candidate;
          taken.add(candidate);
          break;
        }
        n += 1;
      }
      if (!sku) throw new Error(`Could not allocate SKU for ${item.id}`);
      await prisma.menuItem.update({ where: { id: item.id }, data: { sku } });
      assigned += 1;
    }
    totalAssigned += assigned;
    console.log(`${branch.name}: assigned ${assigned} / ${items.length}`);
  }
  console.log(`TOTAL_ASSIGNED=${totalAssigned}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
