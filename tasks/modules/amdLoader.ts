/// <reference path="../../defs/tsd.d.ts"/>

import _ = require('lodash');
import _str = require('underscore.string');
import path = require('path');
import fs = require('fs');

import utils = require('./utils');

var eol = utils.eol;
var grunt = utils.grunt;
var pathSeperator = path.sep;

/////////////////////////////////////////////////////////////////////
// AMD Loader, creates a js file that loads a few files in order
// and the rest un orderded, based on the reference.ts spec
////////////////////////////////////////////////////////////////////

export interface IReferences {
    all: string[];
    before: string[];
    generated: string[];
    unordered: string[];
    after: string[];
}

export enum ReferenceOrder {
    before,
    unordered,
    after
}

export function getReferencesInOrder(referenceFile: string, referencePath: string, generatedFiles: string[]): IReferences {
    var toreturn: IReferences = {
        all: [],
        before: [],
        generated: [],
        unordered: [],
        after: []
    };

    var sortedGeneratedFiles = _.sortBy(generatedFiles);

    function isGeneratedFile(filename: string): boolean {
        return _.indexOf(sortedGeneratedFiles, filename, true) !== -1;
    }

    // When reading
    var referenceMatch = /\/\/\/ <reference path=\"(.*?)\"/;

    // When writing
    var referenceIntro = '/// <reference path="';
    // var referenceEnd = '" />';

    // The section of unordered files
    var ourSignatureStart = '//grunt-start';
    var ourSignatureEnd = '//grunt-end';

    var lines = fs.readFileSync(referenceFile).toString().split('\n');

    // Which of the three sections we are in
    var loopState = ReferenceOrder.before;

    for (var i = 0; i < lines.length; i++) {

        var line = _str.trim(lines[i]);

        if (_str.include(line, ourSignatureStart)) {
            // Wait for the end signature:
            loopState = ReferenceOrder.unordered;
        }
        if (_str.include(line, ourSignatureEnd)) {
            loopState = ReferenceOrder.after;
        }


        // Fetch the existing reference's filename if any:
        if (_str.include(line, referenceIntro)) {
            var match = line.match(referenceMatch);
            var filename = match[1];
            switch (loopState) {
                case ReferenceOrder.before:
                    toreturn.before.push(filename);
                    break;
                case ReferenceOrder.unordered:
                    if (isGeneratedFile(filename)) {
                        toreturn.generated.push(filename);
                    }
                    else {
                        toreturn.unordered.push(filename);
                    }
                    break;
                case ReferenceOrder.after:
                    toreturn.after.push(filename);
                    break;
            }
        }
    }

    // Fix the references to be absolute:
    toreturn.before = _.map(toreturn.before, (relativePath) => path.resolve(referencePath, relativePath));
    toreturn.generated = _.map(toreturn.generated, (relativePath) => path.resolve(referencePath, relativePath));
    toreturn.unordered = _.map(toreturn.unordered, (relativePath) => path.resolve(referencePath, relativePath));
    toreturn.after = _.map(toreturn.after, (relativePath) => path.resolve(referencePath, relativePath));
    toreturn.all = Array.prototype.concat.call([], toreturn.before, toreturn.generated, toreturn.unordered, toreturn.after);

    return toreturn;
}

// It updates based on the order of reference files
export function updateAmdLoader(referenceFile: string, files: IReferences, loaderFile: string, loaderPath: string, outDir: string) {

    // Read the original file if it exists
    if (fs.existsSync(referenceFile)) {
        grunt.log.verbose.writeln('Generating amdloader from reference file ' + referenceFile);

        // Filter.d.ts,
        if (files.all.length > 0) {
            grunt.log.verbose.writeln('Files: ' + files.all.map((f) => f.cyan).join(', '));
        }
        else {
            grunt.warn('No files in reference file: ' + referenceFile);
        }
        if (files.before.length > 0) {
            files.before = _.filter(files.before, (file) => { return !utils.endsWith(file, '.d.ts'); });
            grunt.log.verbose.writeln('Before: ' + files.before.map((f) => f.cyan).join(', '));
        }
        if (files.generated.length > 0) {
            files.generated = _.filter(files.generated, (file) => { return !utils.endsWith(file, '.d.ts'); });
            grunt.log.verbose.writeln('Generated: ' + files.generated.map((f) => f.cyan).join(', '));
        }
        if (files.unordered.length > 0) {
            files.unordered = _.filter(files.unordered, (file) => { return !utils.endsWith(file, '.d.ts'); });
            grunt.log.verbose.writeln('Unordered: ' + files.unordered.map((f) => f.cyan).join(', '));
        }
        if (files.after.length > 0) {
            files.after = _.filter(files.after, (file) => { return !utils.endsWith(file, '.d.ts'); });
            grunt.log.verbose.writeln('After: ' + files.after.map((f) => f.cyan).join(', '));
        }

        // If target has outDir we need to make adjust the path
        // c:/somefolder/ts/a , c:/somefolder/ts/inside/b  + c:/somefolder/build/js => c:/somefolder/build/js/a , c:/somefolder/build/js/inside/b
        // Logic:
        //     find the common structure in the source files ,and remove it
        //          Finally: outDir path + remainder section
        if (outDir) {
            // Find common path
            var commonPath = utils.findCommonPath(files.before.concat(files.generated.concat(files.unordered.concat(files.after))), pathSeperator);
            grunt.log.verbose.writeln('Found common path: ' + commonPath);

            // Make sure outDir is absolute:
            outDir = path.resolve(outDir);
            grunt.log.verbose.writeln('Using outDir: ' + outDir);

            function makeRelativeToOutDir(files: string[]) {
                files = _.map(files, (file) => {
                    // Remove common path and replace with absolute outDir
                    file = file.replace(commonPath, outDir);

                    // remove ts extension '.ts':
                    file = file.substr(0, file.length - 3);

                    // Make relative to amd loader
                    file = utils.makeRelativePath(loaderPath, file);

                    // Prepend "./" to prevent "basePath" requirejs setting from interferring:
                    file = './' + file;

                    return file;
                });
                return files;
            }

            grunt.log.verbose.writeln('Making files relative to outDir...');
            files.before = makeRelativeToOutDir(files.before);
            files.generated = makeRelativeToOutDir(files.generated);
            files.unordered = makeRelativeToOutDir(files.unordered);
            files.after = makeRelativeToOutDir(files.after);

            var mainTemplate = _.template('define(function (require) { '
                + eol + '<%= body %>'
                + eol + '});');

            // The order in the before and after files is important
            var singleRequireTemplate = _.template('\t require([<%= filename %>],function (){'
                + eol + '<%= subitem %>'
                + eol + '\t });');


            // initial sub item
            var subitem = '';


            // Write out a binary file:
            var binaryTemplate = _.template('define(["<%= filenames %>"],function () {});');
            var binaryFilesNames = files.before.concat(files.generated.concat(files.unordered.concat(files.after)));
            var binaryContent = binaryTemplate({ filenames: binaryFilesNames.join('","') });
            var binFileExtension = '.bin.js';
            var loaderFileWithoutExtension = path.dirname(loaderFile) + pathSeperator + path.basename(loaderFile, '.js');
            var binFilename = loaderFileWithoutExtension + binFileExtension;
            grunt.file.write(binFilename, binaryContent);
            grunt.log.verbose.writeln('Binary AMD loader written ' + binFilename.cyan);

            //
            // Notice that we build inside out in the below sections:
            //

            // Generate fileTemplate from inside out
            // Start with after
            // Build the subitem for ordered after items
            files.after = files.after.reverse();     // Important to build inside out
            _.forEach(files.after, (file) => {
                subitem = singleRequireTemplate({ filename: '"' + file + '"', subitem: subitem });
            });

            // Next up add the unordered items:
            // For these we will use just one require call
            if (files.unordered.length > 0) {
                var unorderFileNames = files.unordered.join('",' + eol + '\t\t  "');
                subitem = singleRequireTemplate({ filename: '"' + unorderFileNames + '"', subitem: subitem });
            }

            // Next the generated files
            // For these we will use just one require call
            var generatedFileNames = files.generated.join('",' + eol + '\t\t  "');
            subitem = singleRequireTemplate({ filename: '"' + generatedFileNames + '"', subitem: subitem });

            // Build the subitem for ordered before items
            files.before = files.before.reverse();
            _.forEach(files.before, (file) => {
                subitem = singleRequireTemplate({ filename: '"' + file + '"', subitem: subitem });
            });

            // The last subitem is now the body
            var output = mainTemplate({ body: subitem });

            // Finally write it out
            grunt.file.write(loaderFile, output);
            grunt.log.verbose.writeln('AMD loader written ' + loaderFile.cyan);
        }
    }
    else {
        grunt.log.writeln('Cannot generate amd loader unless a reference file is present'.red);
    }
}
