const yarg = require("yargs/yargs");
const hideBin = require("yargs/helpers").hideBin;
const os = require("os");
const fs = require("fs");
const path = require("path");
const exit = require("process").exit;
const fileiv = require("./cryptoc").generate_iv();
const chalk = require("chalk");


let table = {};
let tablefile;

let starttime;
let endedtime;

let _err;

/**
 * ireto variables ireto dia ampiasaina amin'ny connexion mongodb
 */
var mongo;
var mongodbname;
var db;
var mongoclientUrl;;
var mongoclient;

/**
 * ireto variables manaraka ireto kosa ho an'ny connexion oracle
 */
var oracleuser;
var oraclepass;
var oraclehost;
var oracleport;


var tablevalidator_processed = [];
async function fetch_table_structure_and_data() {
    const oracle = require("oracledb");
    oracle.outFormat = oracle.OUT_FORMAT_OBJECT;

    let connection;

    try {
        connection = await oracle.getConnection({
            user: oracleuser,
            password: oraclepass,
            connecionString: `${oraclehost}:${oracleport}/XE`
        })


        //
        console.log("\n");
        console.log("==========================================================================");
        console.log(chalk.rgb(175, 143, 16)("Fetching global info"));
        console.log("==========================================================================");


        let table_result = await connection.execute(`
            SELECT table_name, tablespace_name, num_rows 
            FROM all_tables
            WHERE tablespace_name IS NOT NULL AND tablespace_name = '${oracleuser.toUpperCase()}' AND owner = '${oracleuser.toUpperCase()}'
            `);


        let table_column_result;
        let table_cons_result;
        let table_cons_rel_result;
        let table_data_result;
        let table_detail;

        for (_table of table_result.rows) {
            //
            console.log("Fetching informations for table : " + _table.TABLE_NAME);


            /**
             * alaina ny detail an'ilay table
             */
            table_detail = {};
            table_column_result = await connection.execute(`
                SELECT column_name, data_type, data_length, data_precision, nullable, character_set_name 
                FROM all_tab_cols
                WHERE owner = '${oracleuser.toUpperCase()}' AND table_name = '${_table.TABLE_NAME}' 
                `);

            /**
             * atao anaty objet ho synthetisena
             */
            table_detail = {
                NAME: _table.TABLE_NAME,
                ROWS: _table.NUM_ROWS,
                COLUMNS: [],
                CONSTRAINTS: [],
                DATA: []
            }

            /**
             * tadiavina ny contrainte par table
             */
            table_cons_result = await connection.execute(`
                SELECT cc.column_name, c.constraint_name, c.constraint_type, c.search_condition
                FROM all_cons_columns cc 
                INNER JOIN all_constraints c ON c.constraint_name = cc.constraint_name 
                WHERE c.table_name = '${_table.TABLE_NAME}'
                ORDER BY column_name ASC
                `);

            for (_primary of table_cons_result.rows) {
                /**
                 * dia raha PRIMARY ilay contrainte dia tadiavina raha reference any anaty table hafa izy
                 * dia raha reference dia alaina ny table misy azy sy ny colonne mila azy
                 */
                if (_primary.CONSTRAINT_TYPE === "P") {
                    table_cons_rel_result = await connection.execute(`
                        SELECT u.table_name, u.search_condition, c.column_name FROM user_constraints u
                        INNER JOIN all_cons_columns c
                        ON u.constraint_name = c.constraint_name
                        WHERE r_constraint_name = '${_primary.CONSTRAINT_NAME}' 
                        `);


                    if (table_cons_rel_result.rows.length > 0) {
                        for (_relation of table_cons_rel_result.rows) {
                            if (_primary.CONSTRAINT_REFERENCE === undefined) _primary.CONSTRAINT_REFERENCE = [];
                            _primary.CONSTRAINT_REFERENCE.push(_relation);
                        }
                    }
                }
            }


            /**
             * sintomina daholo ny donnees an'ilay table en cours
             */
            table_data_result = await connection.execute(`
                        SELECT * FROM ${_table.TABLE_NAME}
                        `);

            // ampidirina anaty objet global avy eo ny colonne
            table_detail.COLUMNS = table_column_result.rows;
            // manaraka ny contrainte
            table_detail.CONSTRAINTS = table_cons_result.rows;
            // dia ny farany ny donnees
            table_detail.DATA = table_data_result.rows;


            /**
             * ampidirina anaty objet global ny table
             */
            if (table[_table.TABLESPACE_NAME]) {
                table[_table.TABLESPACE_NAME].TABLES.push(table_detail);
            }

            else {
                table[_table.TABLESPACE_NAME] = {
                    NAME: _table.TABLESPACE_NAME,
                    TABLES: [table_detail]
                }
            }
        };

        //
        console.log("Writing data to temporary json file");
        connection.close();

        table["migration_header$"] = {
            version: "1.0",
            date: new Date().toLocaleDateString("fr") + " " + new Date().toLocaleTimeString("fr"),
            description: "Migration file from Oracle database",
            hash: require("./cryptoc").generate_iv()
        };
        table["migration_header$"].key = require("./cryptoc").crypt(fileiv, table["migration_header$"].hash);

        fs.writeFileSync(tablefile, JSON.stringify(table));
        return tablefile;
    }
    catch (err) {
        _err = new Error();
        _err.message = chalk.rgb(196, 36, 0)("\n" + err);
        _err.name = chalk.rgb(255, 174, 0)("oracle_execution_error");
        throw _err;
    }
}

async function sort_extracted_data(file) {
    let _data;
    let _data_tablespace;
    let _order_val = {};

    let _constraint_rel = {};
    let _constraint_ref;

    try {
        _data = JSON.parse(fs.readFileSync(file));
        _data_tablespace = _data[Object.keys(_data)[0]];
    }
    catch (err) {
        _err = new Error();
        _err.message = chalk.rgb(196, 36, 0)("\n" + err);
        _err.name = chalk.rgb(255, 174, 0)("tablespace_file_not_found");
        throw _err;
    }

    //
    console.log("Sorting table before saving structure");

    for (_data_key of Object.keys(_data)) {
        if (_data_key !== "migration_header$") {
            _order_val = {};
            _data_tablespace = _data[_data_key];

            for (_table of _data_tablespace.TABLES) {
                /**
                 * alaina tsirairay ny table aloha
                 */
                for (_constraint of _table.CONSTRAINTS) {
                    /**
                     * jerena tsirairay raha misy contrainte ao anatinle izy
                     * ka izay manana reference ny contrainte dia enregistrer-na ilay relation an'ilay table sy ny
                     * table ao anatin'ilay contrainte de reference
                     */
                    if (_constraint.CONSTRAINT_REFERENCE) {

                        for (_constraint_ref of _constraint.CONSTRAINT_REFERENCE) {

                            /**
                             * ampiasaina io rehefa andeha hametraka ny ordre de priorite an'ilay table amin'izay
                             * amin'ny fotoana hamindrana ny structure any amin'ny MongoDB
                             */
                            if (_constraint_rel[_constraint_ref.TABLE_NAME] === undefined) {
                                _constraint_rel[_constraint_ref.TABLE_NAME] = {};
                                _constraint_rel[_constraint_ref.TABLE_NAME].rside = {
                                    REF_TABLE: _table.NAME,
                                    REF_COLUMN: _constraint.COLUMN_NAME,
                                    TAG_COLUMN: _constraint_ref.COLUMN_NAME
                                }
                            }
                            else {
                                _constraint_rel[_constraint_ref.TABLE_NAME].lside = {
                                    REF_TABLE: _table.NAME,
                                    REF_COLUMN: _constraint.COLUMN_NAME,
                                    TAG_COLUMN: _constraint_ref.COLUMN_NAME
                                }
                            }
                        }
                    }
                }
            }


            /**
             * rehefa azo daholo ny contrainte dia averina jerena indray ny table
             */
            for (_table of _data_tablespace.TABLES) {
                _order_val[_table.NAME] = 0;

                /**
                 * apetraka ho 0 daholo ny priorite dia jerena raha manana parent iny table iny
                 */
                if (_constraint_rel[_table.NAME] && Object.keys(_constraint_rel[_table.NAME]).length === 1) {
                    /**
                     * raha manana izy dia ovana arakaraka ny priorite an'ny parent ny priorite-any
                     */
                    for (_constraint_key of Object.keys(_constraint_rel[_table.NAME])) {
                        _order_val[_table.NAME] = update_order(_constraint_rel[_table.NAME][_constraint_key].REF_TABLE, _constraint_rel);
                        isNaN(_order_val[_table.NAME]) ? _order_val[_table.NAME] = 0 : null;
                    }
                    delete _constraint_rel[_table.NAME];
                }

                /*else if (_constraint_rel[_table.NAME] && Object.keys(_constraint_rel[_table.NAME]).length === 2) {
                    delete _order_val[_table.NAME];
                }*/
            }

            _order_val = Object.assign(_order_val, min_max_order_value(Object.values(_order_val)));

            _data_tablespace.TABLES_ORDER = _order_val;
            _data_tablespace.TABLES_FOREIGN_RELATION = _constraint_rel;

            _data[Object.keys(_data)[0]] = _data_tablespace;
        }
    }

    //
    console.log("Saving sort result to temporary file");
    fs.writeFileSync(file, JSON.stringify(_data));

    function update_order(_table, _table_relation) {
        let _order_temp = [0];

        /**
         * jerena raha manana parent ilay table en cours
         */
        if (_table_relation[_table]) {
            /**
             * raha manana izy dia jerena daholo izay mety ho parent satria mety ho 1 izany
             * mety ho maromaro
             */
            for (_relation of Object.keys(_table_relation[_table])) {

                //console.log(update_order(_constraint_rel[_table][_relation].REF_TABLE, _constraint_rel), _table)
                /**
                 * jerena indray raha manana parent ilay parent an'ilay table en cours
                 * izany hoe ilay parent indray izany no lasa table en cours amin'izay fotoana izay
                 * 
                 * ampidirina anaty tableau ny priorite an'ilay parent rehetra
                 */
                //_order_temp.push(update_order(_constraint_rel[_table][_relation].REF_TABLE, _constraint_rel));
                _order_temp.push(update_order(_constraint_rel[_table][_relation].REF_TABLE, _constraint_rel));
            }
        }

        /**
         * izay maximum amin'ny priorite an'ny parents eo ampianay iray izany no tokony
         * ho priorite an'ilay table en cours
         */
        return Math.max(_order_temp) + 1;
    }

    function min_max_order_value(order) {
        let min = order[0];
        let max = order[0];
        for (order_value of order) {
            if (order_value < min) min = order_value;
            if (order_value > max) max = order_value;
        }
        return {
            $MINMAX_ORDER_VALUE: {
                $MIN: min,
                $MAX: max
            }
        }
    }
}

async function create_validator(file) {
    //
    console.log("\n");
    console.log("==========================================================================");
    console.log(chalk.rgb(175, 143, 16)("Initializing validation schema"));
    console.log("==========================================================================");

    let validator = {
        validate: function (data, _this = this) {
            const properties = _this["properties"];

            if (data.length > 0) {
                data = data.map(function (_dt) {
                    return format(_dt);
                });
            }
            else {
                data = format(data);
            }

            function format(_data) {
                for (keys of Object.keys(properties)) {
                    switch (properties[keys].bsonType) {
                        case "date": _data[keys] = new Date(_data[keys]); break;
                        case "number": _data[keys] = parseInt(_data[keys]); break;
                        case "string": _data[keys] = String(_data[keys]); break;
                    }
                }
                return _data;
            }

            return data;
        }
    };
    let validation_file = file;
    let validation_content;
    let validation_order;

    let order_min;
    let order_max;

    validation_content = JSON.parse(fs.readFileSync(validation_file, "utf-8"));
    validation_order = validation_content[Object.keys(validation_content)[0]].TABLES_ORDER;
    validation_content = validation_content[Object.keys(validation_content)[0]];

    order_min = validation_order.$MINMAX_ORDER_VALUE.$MIN;
    order_max = validation_order.$MINMAX_ORDER_VALUE.$MAX;
    delete validation_order.$MINMAX_ORDER_VALUE;

    for (_i = order_min; _i <= order_max; _i++) {

        for (_tablename of map_data_by_order_value(_i, validation_order)) {

            //
            console.log("Processing migration schema for collection : " + _tablename);


            _content = validation_content.TABLES.filter(function (_table) {
                if (_table.NAME === _tablename) return _table;
            })[0];


            validator.bsonType = "object";
            validator.description = `Mapping of table "${_content.NAME}" from Oracle database`;
            validator.required = [];
            validator.properties = {};

            var _colcons;
            var _colunique = {};

            for (_column of _content.COLUMNS) {

                /**
                 * ampidirina anaty liste critere aloha ilay colonne
                 * raha ohatra ka tsy mbola tafiditra anaty required
                 */
                validator.required.indexOf(_column.COLUMN_NAME) === -1 ?
                    validator.required.push(_column.COLUMN_NAME) :
                    validator.required = validator.required;

                /**
                 * raisina ny contrainte misy eo aminy
                 */
                _colcons = get_constraint_from_name(
                    _column.COLUMN_NAME,
                    _content.CONSTRAINTS
                );

                /**
                 * izay cle primaire dia avadika unique index
                 */
                for (_constraint of _colcons) {
                    if (
                        _constraint.CONSTRAINT_TYPE === "P" ||
                        _constraint.CONSTRAINT_TYPE === "R"
                    ) _colunique[_constraint.COLUMN_NAME] = 1;
                }

                /**
                 * alaina avy eo ny valeur anle colonne ao anaty required raha efa misy
                 * raha mbola tsy misy dia tsy maintsy mamorona hafa mazava ho azy
                 */
                _f = validator.properties[_column.COLUMN_NAME];
                _f ?
                    _f = _f :
                    _f = {};

                /**
                 * mapping an'ilay datatype avy any amin'ny oracle mankany amin'ny datatype mongodb
                 * raha null autorise ilay champ dia avadika array ilay datatype
                 * tsy mety raha array a une seule valeur ny bsontype
                 */
                _f.bsonType = map_data_type_from_oracle(_column.DATA_TYPE);
                _column.NULLABLE === "Y" ?
                    _f.bsonType = Array().concat(_f.bsonType, "null") :
                    _f.bsonType = _f.bsonType;

                /**
                 * enregistrer ammzay ny donnees de validation an'ilay champ
                 */
                validator.properties[_column.COLUMN_NAME] = _f;
            }

            await save_data_to_catalog(_content, validator, _colunique);

            tablevalidator_processed.push(_content.NAME);
        }

    }


    function get_constraint_from_name(colname, conslist) {
        return conslist.filter(function (col) {
            if (col.COLUMN_NAME === colname) return col;
        });
    }

    function map_data_by_order_value(order, orderlist) {
        return Object.keys(orderlist).filter(function (tablename) {
            if (orderlist[tablename] === order) return tablename;
        })
    }

    return true;
}

async function save_data_to_catalog(_collection, _collection_validator, _uniqueindex) {
    try {

        await db.createCollection(format_tablename(_collection.NAME), {
            validator: {
                $jsonSchema: _collection_validator
            }
        });

        if (Object.keys(_uniqueindex).length !== 0 && Object.keys(_uniqueindex).indexOf("OID") === -1) await db.collection(format_tablename(_collection.NAME)).createIndex(_uniqueindex, { unique: 1 });

        if (
            _collection.DATA &&
            _collection.DATA.length > 0
        ) {
            await db.collection(format_tablename(_collection.NAME)).insertMany(_collection_validator.validate(_collection.DATA));
            return true;
        }
    }
    catch (err) {
        _err = new Error();
        _err.message = chalk.rgb(196, 36, 0)("\n" + err);
        _err.name = chalk.rgb(255, 174, 0)("mongodb_validator_error");
        throw _err;
    }
}

async function update_validator_for_table_relation(file) {
    //
    console.log("\n");
    console.log("Getting every many-to-many relationships");

    try {
        let db = mongoclient.db(mongodbname);

        let foreign_key;

        let lside;
        let rside;
        let _lcollection;
        let _rcollection;

        var _data;
        var _data_relation;

        foreign_key = JSON.parse(fs.readFileSync(file, "utf-8"));

        for (tablespace of Object.keys(foreign_key)) {
            if (tablespace !== "migration_header$") {
                _data = foreign_key[tablespace].TABLES;
                _data_relation = foreign_key[tablespace].TABLES_FOREIGN_RELATION;

                //
                console.log("Found : " + Object.keys(_data_relation).length);
                console.log("Preparing collection for data processing");

                for (_relation of Object.keys(_data_relation)) {
                    foreign_data = _data.filter(function (_table_content) {
                        if (_table_content.NAME === _relation) return _table_content;
                    })[0];
                    console.log("Processing collection : " + _relation);

                    /**
                     * raisina daholo aloha ny table anakiroa ao anaty relation plusieurs plusieurs
                     * zarana roa mazava tsara aloha hoe misy leftside sy rightside
                     */
                    lside = _data_relation[_relation].lside;
                    rside = _data_relation[_relation].rside;


                    /**
                     * averina formatter-na avy eo ny validation_schema an'ilay collection anakiroa
                     */
                    _lcollection = await preparing_collection_schema(lside, rside);
                    _rcollection = await preparing_collection_schema(rside, lside);


                    /** 
                     * enregistrer-na any amin'ny base amin'izay ny modification rehetra
                     */
                    await update_data_from_relationships(_lcollection.collection, _lcollection.validation);
                    await update_data_from_relationships(_rcollection.collection, _rcollection.validation);

                    async function preparing_collection_schema(_coll, _coll_relation) {
                        let _collection;
                        let _collection_validator;
                        let _collection_rel_data;

                        let _f;


                        /**
                         * alaina ny validation_schema efa napetraka teo amin'ilay collection _coll
                         * alaina koa avy eo ny structure an'ilay colonne nasina ilay reference cle etrangere tao amin'ny table relationnelle
                         */
                        _collection = _coll.REF_TABLE;
                        _collection_validator = await db.collection(format_tablename(_collection)).options();
                        _collection_validator = _collection_validator.validator["$jsonSchema"];

                        _collection_rel_data = fetch_column_structure(_coll_relation.REF_TABLE, _coll_relation.REF_COLUMN)[0];

                        /**
                         * verifier-na ihany sao dia efa misy cle mitovy amin'ny anaran'ilay reference ao anatin'ilay validation_schema
                         * dia raha tsy misy dia ampidirina ao ilay cle
                         * dia avy eo marquer-na ho unique iny cle iny
                         */
                        _collection_validator.required.indexOf(_coll_relation.TAG_COLUMN) === -1 ?
                            _collection_validator.required.push(_coll_relation.TAG_COLUMN) :
                            _collection_validator.required = _collection_validator.required;

                        /**
                         * enregistre-na avy eo izay modification natao tao amin'ilay validation_schema rehetra
                         * ampidirina ao anatiny ilay cle vaovao
                         */
                        _f = {};
                        _f.bsonType = "array";
                        _f.minItems = 0;
                        _f.uniqueItems = true;
                        _f.items = {
                            bsonType: map_data_type_from_oracle(_collection_rel_data.DATA_TYPE)
                        }

                        _collection_validator.properties[_coll_relation.TAG_COLUMN] = _f;

                        /**
                         * foramtter-na amin'izay ny donnees rehetra mba ho enregistrer-na any amin'ny base de donnees
                         */
                        _collection = { NAME: _collection };
                        _collection.DATA = foreign_data.DATA;
                        _collection.REF_COLUMN = _coll.REF_COLUMN;
                        _collection.TAG_COLUMN = _coll.TAG_COLUMN;
                        _collection.NDD_COLUMN = _coll_relation.TAG_COLUMN;

                        return {
                            collection: _collection,
                            validation: _collection_validator
                        };
                    }
                }
            }
        }

        return true;
    }
    catch (err) {
        _err = new Error();
        _err.message = chalk.rgb(196, 36, 0)("\n" + err);
        _err.name = chalk.rgb(255, 174, 0)("mongodb_validator_update_error");
        throw _err;
    }

    function fetch_column_structure(tablename, columnname) {
        let _table_data;

        _table_data = _data.filter(function (_table) {
            if (_table.NAME === tablename) return _table;
        });
        _table_data = _table_data[0].COLUMNS.filter(function (_column) {
            if (_column.COLUMN_NAME === columnname) return _column;
        });

        return _table_data;
    }
}

async function update_data_from_relationships(_collection, _collection_validator) {
    /**
     * enregistrena ilay schema vaidation vaovao
     */
    await db.command({
        collMod: format_tablename(_collection.NAME),
        validator: {
            $jsonSchema: _collection_validator
        }
    });

    let colldata;
    let colldata_filtered;
    /**
     * raisina daholo ny donnees tao anatin'ilay collection
     */
    colldata = await db.collection(format_tablename(_collection.NAME)).find({}).toArray();

    for (_data of colldata) {
        /**
         * filtrena ilay donnees avy any amin'ny RDBMS ka izay mitovy valeur amin'ny champs de reference avy any amin'ny
         * RDBMS ao amin'ny collection dia atambatra anaty array() anakiray
         * 
         * esoriana daholo ny cle rehetra ao fa tokony valeur sisa no azo
         * array() d'element de type primitif izany no contenu fa tsy array() de type objet
         */

        colldata_filtered = _collection.DATA.filter(function (_d) {
            if (_data[_collection.REF_COLUMN] === _d[_collection.TAG_COLUMN]) return _d;
        });
        colldata_filtered = colldata_filtered.map(function (_d) { return _d[_collection.NDD_COLUMN]; });
        _data[_collection.NDD_COLUMN] = colldata_filtered;

        /**
         * raha nisy correspondance izay vao manao mise-a-jour ny donnees ao anaty catalogue
         */

        if (_data[_collection.NDD_COLUMN].length > 0) {
            await db.collection(format_tablename(_collection.NAME)).updateOne({ _id: _data._id }, { $set: _data });
        }
    }

    return true;
}


/**
 * anaovana simulation de rollback fotsiny ity fonction ity
 */
async function rollback() {
    try {
        //
        console.log(chalk.rgb(120, 120, 120)("Rollback all operations"));
        console.log("Drop collections");
        for (_coll of tablevalidator_processed) {
            await db.collection(format_tablename(_coll)).drop();
        }
        console.log("Drop database");
    }
    catch (err) {
        console.log(err)
    }
}

/**
     * ireto fonction ireto kosa tsy dia tena oe importante saingy miasa ao anatin'ireo fonction importante
     */
function map_data_type_from_oracle(datatype) {
    switch (datatype) {
        case "NUMBER": return "number"; break;
        case "VARCHAR2": return "string"; break;
        case "DATE": return "date"; break;
        case "RAW": return "object"; break;
        default: return "string"; break;
    }
}

function format_tablename(name) {
    return name.replace(/[$]/ig, "");
}

yarg(hideBin(process.argv))
    .command("makemigration", "", function (yargs) {
        return yargs
    }, async function (argv) {
        if (argv.username && argv.secret) {
            try {
                starttime = new Date();

                var tablevalidator;

                oracleuser = argv.u;
                oraclepass = argv.s;
                oraclehost = argv.h;
                oracleport = argv.p;

                tablefile = argv.o;

                /**
                 * 1)   sintomina daholo ny structure an'ny tables rehetra ao anay tablespace miaraka amin'ny donnees dia enregistrer-na anaty fichier
                 * 2)   trier-na ilay liste de table mba ho fantratra hoe iza no tables tokony creer-na mialoha ny tables sasany
                 * 3)   creer-na ny schema de validation an'ilay table rehetra teo aloha
                 * 3.5) enregistrer-na amin'izay ilay collection rehefa avy nocreer-na ny structure miaraka amin'ny validation
                 * 3.6) enregistrer-na ny donnees tokony ho ao anaty collection tsirairay avy
                 * 
                 */

                tablevalidator = await fetch_table_structure_and_data();
                await sort_extracted_data(tablevalidator);

                endedtime = new Date();
                //
                console.log("\n");
                console.log("=========================================================================================");
                console.log("Finished");
                console.log("Start : " + chalk.rgb(175, 143, 16)(starttime.toLocaleDateString("fr") + " " + starttime.toLocaleTimeString("fr")));
                console.log("End   : " + chalk.rgb(175, 143, 16)(endedtime.toLocaleDateString("fr") + " " + endedtime.toLocaleTimeString("fr")));
                console.log("Datafile : " + chalk.rgb(19, 195, 16)(argv.o));
                console.log("=========================================================================================");
            }
            catch (err) {
                console.log(chalk.bgRgb(170, 31, 0)("We encounter an error while processing the request"));
                await rollback();
                if (mongoclient) mongoclient.close();
                throw err;
            }
        }
        else {
            console.log(chalk.rgb(170, 31, 0)("Params missing for command"));
            console.log("Example :");

            console.log(`
    ${chalk.rgb(175, 143, 16)("node index makemigration -h hostname -p port -u username -s password")}
    ${chalk.rgb(175, 143, 16)("node index makemigration --host hostname --port port --username username --secret password")}
    Parameters with default value are optionals.    

        Options:
        --help        Show help                                                     [boolean]
        --version     Show version number                                           [boolean]
    -h, --host        The IP address or the domain name of the Oracle server        [string] 
                                [default: "127.0.0.1"]
    -p, --port        The port on which Oracle is listening                         [int] [default: 1521]
    -u, --username    The username which will be used to connect to the server      [string]
    -s, --secret      The password for the provided username                        [string]
        -o, --outputfile  The path where the temporary migration file will be saved [string] 
                [default: "C:\Users\ASH\AppData\Local\Temp\0c88a15d77b6bd0ecbc198f69434b624.json"]
                `);

        }
    })
    .option("host", { alias: "h", type: "string", description: "The IP address or the domain name of the Oracle server", default: "127.0.0.1" })
    .option("port", { alias: "p", type: "int", description: "The port on which Oracle is listening", default: 1521 })
    .option("username", { alias: "u", type: "string", description: "The username which will be used to connect to the server" })
    .option("secret", { alias: "s", type: "string", description: "The password for the provided username" })
    .option("outputfile", { alias: "o", type: "string", description: "The path where the temporary migration file will be saved", default: path.join(os.tmpdir(), `${fileiv}.json`) })
    .parse();

yarg(hideBin(process.argv))
    .command("migrate", "", function (yargs) {
        return yargs
    }, async function (argv) {
        if (argv.d && argv.i) {
            try {
                inputfile_verification(argv.i);

                starttime = new Date();

                mongo = require("mongodb").MongoClient;
                mongodbname = argv.d;
                mongoclientUrl = "mongodb://localhost:27017";
                mongoclient = new mongo(mongoclientUrl);

                await mongoclient.connect();

                db = mongoclient.db(mongodbname);

                await create_validator(argv.i);
                await update_validator_for_table_relation(argv.i);

                //
                if (argv.r === true) {
                    console.log("Deleting temporary file");
                    fs.unlinkSync(argv.i);
                }


                endedtime = new Date();
                //
                console.log("\n");
                console.log("=========================================================================================");
                console.log("Finished");
                console.log("Start : " + chalk.rgb(175, 143, 16)(starttime.toLocaleDateString("fr") + " " + starttime.toLocaleTimeString("fr")));
                console.log("End   : " + chalk.rgb(175, 143, 16)(endedtime.toLocaleDateString("fr") + " " + endedtime.toLocaleTimeString("fr")));
                console.log("=========================================================================================");

                exit();

                function inputfile_verification(file) {
                    const _f = JSON.parse(fs.readFileSync(file));
                    const _k = _f["migration_header$"];

                    if (_k) {
                        const _h = _k.hash;
                        const _c = _k.key;

                        try {
                            require("./cryptoc").decrypt(_c, _h);
                        }
                        catch (err) {
                            _err = new Error();
                            _err.message = chalk.rgb(196, 36, 0)("\n" + _err);
                            _err.name = chalk.rgb(255, 174, 0)("mongodb_file_input_not_recognized");
                            throw _err;
                        }
                    }
                    else {
                        _err = new Error();
                        _err.message = chalk.rgb(196, 36, 0)("\n" + "Unknown file. The file which was provided as the input file doesn't seem to contain valid header. Please check your input and try again.");
                        _err.name = chalk.rgb(255, 174, 0)("mongodb_file_input_not_recognized");
                        throw _err;
                    }
                }
            }
            catch (err) {
                console.log(chalk.bgRgb(170, 31, 0)("We encounter an error while processing the request"));
                await rollback();
                if (mongoclient) mongoclient.close();
                throw err;
            }
        }
        else {
            console.log(chalk.rgb(170, 31, 0)("Params missing for command"));
            console.log("Example :");

            console.log(`
    ${chalk.rgb(175, 143, 16)("node index makemigration -h hostname -p port -u username -s password")}
    ${chalk.rgb(175, 143, 16)("node index makemigration --host hostname --port port --username username --secret password")}
    Parameters with default value are optionals.    

        Options:
        --help      Show help                                                                              [boolean]
        --version   Show version number                                                                    [boolean]
    -h, --host      The IP address or the domain name of the MongoDB server
                                                                                    [string] [default: "127.0.0.1"]
    -p, --port      The port on which mongoDB is listening                                          [default: 27017]
    -d, --database  The database name which will be created and in which every data will be migrated        [string]
    -r, --rmfile    An option just to know if the program should delete the input file at the end or not   [boolean]
            [default: true]
            `);

        }
    })
    .option("host", { alias: "h", type: "string", description: "The IP address or the domain name of the MongoDB server", default: "127.0.0.1" })
    .option("port", { alias: "p", type: "int", description: "The port on which mongoDB is listening", default: 27017 })
    .option("database", { alias: "d", type: "string", description: "The database name which will be created and in which every data will be migrated" })
    .option("inputfile", { alias: "i", type: "string", description: "The migration file from Oracle" })
    .option("rmfile", { alias: "r", type: "boolean", description: "An option just to know if the program should delete the input file at the end or not", default: true })
    .parse();