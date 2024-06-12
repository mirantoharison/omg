const crypto = require("crypto");
const algorithm = "aes-192-cbc";
const salt = crypto.scryptSync("alpha", "alpha", 24);

var cipher_process = null;
var decipher_process = null;

function generate_iv(length=16){
    var iv_temp = crypto.randomBytes(length);
        iv_temp = iv_temp.toString("hex");
        return iv_temp;
}

function crypt(ciphered, iv){
    iv = Buffer.from(iv, "hex");
    cipher_process = crypto.createCipheriv(algorithm, salt, iv);
    var crypted = cipher_process.update(ciphered, "utf-8", "hex");
    crypted += cipher_process.final("hex");
    return crypted.toString("utf-8");
}

function decrypt(ciphered, iv){
    iv = Buffer.from(iv, "hex");
    decipher_process = crypto.createDecipheriv(algorithm, salt, iv);
    var decrypted = decipher_process.update(ciphered, "hex", "utf-8");
    decrypted += decipher_process.final("utf-8");
    return decrypted.toString("utf-8");
}

exports.crypt = crypt;
exports.decrypt = decrypt;
exports.generate_iv = generate_iv;