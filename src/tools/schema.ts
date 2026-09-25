import { z } from "zod";
import type { McpOperation, McpParam } from "../generated/operations.js";

/**
 * A generated parameter descriptor turned into a Zod type.
 *
 * Deliberately permissive about everything the API validates for itself. Re-encoding maxLength,
 * pattern and cross field rules here would be a second copy of the contract that compiles happily
 * while saying something the API no longer agrees with, which is the exact failure this whole
 * package is built to avoid. What is enforced here is only the shape a request needs to be
 * buildable at all.
 */
function baseType(param: McpParam): z.ZodTypeAny {
  if (param.enum && param.enum.length > 0) {
    return z.enum(param.enum as [string, ...string[]]);
  }
  switch (param.kind) {
    case "boolean":
      return z.boolean();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "object":
      return z.record(z.unknown());
    case "array": {
      if (param.itemEnum && param.itemEnum.length > 0) {
        return z.array(z.enum(param.itemEnum as [string, ...string[]]));
      }
      switch (param.itemKind) {
        case "object":
          return z.array(z.record(z.unknown()));
        case "integer":
        case "number":
          return z.array(z.number());
        case "boolean":
          return z.array(z.boolean());
        default:
          return z.array(z.string());
      }
    }
    default:
      return z.string();
  }
}

export function zodFor(param: McpParam): z.ZodTypeAny {
  let type = baseType(param);
  if (param.nullable) type = type.nullable();
  if (!param.required) type = type.optional();
  const described = describe(param);
  return described ? type.describe(described) : type;
}

function describe(param: McpParam): string {
  const parts: string[] = [];
  if (param.description) parts.push(param.description);
  if (param.format === "uuid") parts.push("A UUID.");
  if (param.format === "date-time") parts.push("ISO 8601 with an offset, for example 2026-09-01T09:00:00Z.");
  if (param.nullable) parts.push("Send null to clear it.");
  return parts.join(" ").trim();
}

/** The tool's whole input shape: the operation's arguments plus the ones the client adds. */
export function inputShapeFor(operation: McpOperation): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of operation.params) shape[param.name] = zodFor(param);

  if (operation.ifMatch) {
    shape.if_match = z
      .string()
      .optional()
      .describe(
        "The ETag from your last read of this object. Send it and the write is refused if somebody else changed the object in the meantime, rather than silently overwriting their work.",
      );
  }
  if (operation.approval) {
    shape.approval_id = z
      .string()
      .uuid()
      .optional()
      .describe(
        "Only when a previous call to this tool returned an approval link and the user has since approved it: the approval id from that reply. Send exactly the same other arguments as that call. Leave it out otherwise.",
      );
  }
  if (operation.confirm) {
    shape.confirm = z
      .boolean()
      .optional()
      .describe(
        "Set to true only after the user has explicitly agreed to this action. Calling without it returns a description of what would happen and changes nothing.",
      );
  }
  return shape;
}
