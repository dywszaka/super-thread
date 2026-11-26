import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialEncryption } from "../../src/main/persistence/git-hosting-store";

/** OS encryption is injected in Node tests; authenticated encryption exercises real file boundaries. */
export function testEncryption(): CredentialEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    }
  };
}
