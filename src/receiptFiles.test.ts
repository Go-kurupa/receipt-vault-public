import { expect, it } from "vitest";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, classifyOriginal, validateUploadFile } from "./receiptFiles";

it.each([
  [{ storagePath: "original.PDF" }, "pdf"],
  [{ mimeType: "application/pdf", storagePath: "original" }, "pdf"],
  [{ mimeType: "image/png", storagePath: "original.pdf" }, "pdf"],
  [{ storagePath: "original.JPEG" }, "image"],
  [{ storagePath: "original.png?x=1" }, "image"],
  [{ mimeType: "image/jpeg" }, "image"],
  [{ storagePath: "original.txt" }, "unknown"],
  [{ mimeType: null, storagePath: null }, "unknown"],
])("原本 %j を %s と分類する", (input, expected) => expect(classifyOriginal(input)).toBe(expected));
it.each([
  [0, "application/pdf", "a.pdf", false],
  [MAX_UPLOAD_BYTES, "application/pdf", "a.pdf", true],
  [MAX_UPLOAD_BYTES + 1, "application/pdf", "a.pdf", false],
  [1, "text/plain", "a.pdf", false],
  [1, "", "a.PDF", true],
  [1, "", "a.jpeg", true],
  [1, "", "a.png", true],
  [1, "", "a.txt", false],
  [1, "constructor", "a.pdf", false],
])("ファイル境界 %s %s %s", (size, type, name, valid) => {
  const result = validateUploadFile({ size, type, name });
  expect(result.error === null).toBe(valid);
  if (result.error) {
    expect(result.error).toContain("8 MiB");
    expect(result.error).toContain("PDF・JPEG・PNG");
  } else expect(Object.keys(ALLOWED_MIME)).toContain(result.mimeType);
});
