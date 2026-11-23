import { defineRule } from "@oxlint/plugins";

const BANNED_NAME = "isRecord";
const LOOSE_VALUE_TYPES = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);

/**
 * Ban `isRecord` helpers and type guards that narrow to `Record<string, unknown>`.
 *
 * Such a guard only proves "some object". The code after it then reads loose
 * fields by hand. Parse unknown data with a zod schema at the edge, or narrow
 * with `in`, a discriminant, or a better upstream type.
 */
export const noRecordTypeGuardRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban `isRecord` helpers and type guards that narrow to `Record<string, unknown>`.",
    },
    messages: {
      recordGuard:
        "Do not narrow unknown values to `Record<string, unknown>`. Parse them with a zod schema at the edge, or narrow with `in`, a discriminant, or a better type. See policies/runtime-boundary-schemas.md.",
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name !== BANNED_NAME) return;
        const parent = node.parent;
        const declares =
          (parent?.type === "FunctionDeclaration" && parent.id === node) ||
          (parent?.type === "VariableDeclarator" && parent.id === node);
        if (declares) context.report({ node, messageId: "recordGuard" });
      },
      TSTypePredicate(node) {
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (
          annotation?.type !== "TSTypeReference" ||
          annotation.typeName.type !== "Identifier" ||
          annotation.typeName.name !== "Record"
        ) {
          return;
        }
        const [key, value] = annotation.typeArguments?.params ?? [];
        if (
          key?.type === "TSStringKeyword" &&
          value &&
          LOOSE_VALUE_TYPES.has(value.type)
        ) {
          context.report({ node, messageId: "recordGuard" });
        }
      },
    };
  },
});
