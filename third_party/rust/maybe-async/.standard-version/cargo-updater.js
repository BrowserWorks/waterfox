const TOML = require('@iarna/toml')

module.exports.readVersion = function (contents) {
	let data = TOML.parse(contents);
	return data.package.version;
}

module.exports.writeVersion = function (contents, version) {
	let data = TOML.parse(contents);
    data.package.version = version;
	return TOML.stringify(data);
}
