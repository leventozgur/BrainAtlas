// SPDX-License-Identifier: MIT
import Foundation
import Security

func fail(_ code: Int32) -> Never { exit(code) }

let args = CommandLine.arguments
if args.count != 4 { fail(2) }
let action = args[1]
let service = args[2]
let account = args[3]
let identity: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]

if action == "get" {
    var query = identity
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { fail(3) }
    if status != errSecSuccess || !(result is Data) { fail(4) }
    FileHandle.standardOutput.write(result as! Data)
    exit(0)
}

if action == "set" {
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    if secret.isEmpty { fail(4) }
    let update = [kSecValueData as String: secret]
    let status = SecItemUpdate(identity as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
        var item = identity
        item[kSecValueData as String] = secret
        if SecItemAdd(item as CFDictionary, nil) != errSecSuccess { fail(4) }
    } else if status != errSecSuccess { fail(4) }
    exit(0)
}

if action == "delete" {
    let status = SecItemDelete(identity as CFDictionary)
    if status == errSecItemNotFound { fail(3) }
    if status != errSecSuccess { fail(4) }
    exit(0)
}

fail(2)
