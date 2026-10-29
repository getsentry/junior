import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

const ROWS = [
  { cost: "$4.25", created: 5, mergeRate: "80%", name: "getsentry/junior" },
  { cost: "$2.10", created: 3, mergeRate: "100%", name: "getsentry/payments" },
];

/** Show the shared data table with a flexible label column and fixed metric columns. */
export function TableFixture() {
  return (
    <Table className="min-w-[36rem] table-fixed">
      <colgroup>
        <col />
        <col className="w-28" />
        <col className="w-28" />
        <col className="w-28" />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead className="text-right">Created</TableHead>
          <TableHead className="text-right">Merge rate</TableHead>
          <TableHead className="text-right">Median cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ROWS.map((row) => (
          <TableRow key={row.name}>
            <TableCell className="truncate">{row.name}</TableCell>
            <TableCell className="text-right tabular-nums">
              {row.created}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.mergeRate}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.cost}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
