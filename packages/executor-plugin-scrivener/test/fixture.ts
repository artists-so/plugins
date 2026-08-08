/**
 * A synthetic Scrivener project for the test suite.
 *
 * Written by hand to match what Scrivener 3.5.2 puts on disk (the format facts
 * live in intel/scrivener-format.md): attributes for identity and kind, label
 * and status definitions referenced by numeric id, sidecar files under
 * Files/Data, a docs.checksum keyed by lowercased uuid, and RTF with a font
 * table, tab stops and hex escapes. All content is our own.
 *
 * CI runs against this. To run the same suite against a real project on your
 * machine instead, set SCRIV_TEST_PROJECT to the path of a .scriv package —
 * the tests only ever touch a temporary copy.
 */

import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const ACT_ID = '22222222-2222-4222-8222-222222222222';
const RESEARCH_ID = '33333333-3333-4333-8333-333333333333';
const TRASH_ID = '44444444-4444-4444-8444-444444444444';
const FRONT_ID = '55555555-5555-4555-8555-555555555555';
const COPYRIGHT_ID = '66666666-6666-4666-8666-666666666666';

const STAMP = '2026-01-01 09:00:00 +0700';

const SCRIVX = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Identifier="AAAAAAAA-0000-4000-8000-000000000000" Version="2.0" Creator="SCRMAC-3.5.2-16607" Device="fixture" Modified="${STAMP}" ModID="BBBBBBBB-0000-4000-8000-000000000000">
    <Binder>
        <BinderItem UUID="${DRAFT_ID}" Type="DraftFolder" Created="${STAMP}" Modified="${STAMP}">
            <Title>Manuscript</Title>
            <Children>
                <BinderItem UUID="${ACT_ID}" Type="Folder" Created="${STAMP}" Modified="${STAMP}">
                    <Title>Act I</Title>
                </BinderItem>
            </Children>
        </BinderItem>
        <BinderItem UUID="${FRONT_ID}" Type="Folder" Created="${STAMP}" Modified="${STAMP}">
            <Title>Front Matter</Title>
            <Children>
                <BinderItem UUID="${COPYRIGHT_ID}" Type="Text" Created="${STAMP}" Modified="${STAMP}">
                    <Title>Copyright</Title>
                    <MetaData>
                        <IncludeInCompile>Yes</IncludeInCompile>
                    </MetaData>
                </BinderItem>
            </Children>
        </BinderItem>
        <BinderItem UUID="${RESEARCH_ID}" Type="ResearchFolder" Created="${STAMP}" Modified="${STAMP}">
            <Title>Research</Title>
        </BinderItem>
        <BinderItem UUID="${TRASH_ID}" Type="TrashFolder" Created="${STAMP}" Modified="${STAMP}">
            <Title>Trash</Title>
        </BinderItem>
    </Binder>
    <LabelSettings>
        <Title>Track</Title>
        <DefaultLabelID>-1</DefaultLabelID>
        <Labels>
            <Label ID="-1" Name="No Track">No Track</Label>
            <Label ID="1" Color="0.702 0.888 0.974">DAWN</Label>
            <Label ID="2" Color="0.965 0.828 0.514">DAY</Label>
        </Labels>
    </LabelSettings>
    <StatusSettings>
        <Title>Status</Title>
        <DefaultStatusID>-1</DefaultStatusID>
        <StatusItems>
            <Status ID="-1">No Status</Status>
            <Status ID="1">PLANNED</Status>
            <Status ID="2">DRAFTED</Status>
        </StatusItems>
    </StatusSettings>
</ScrivenerProject>
`;

// Scrivener-shaped RTF: cocoartf header, font table naming Palatino, colour
// table, tab stops, a hex-escaped copyright sign. The prose is ours.
const COPYRIGHT_RTF = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\froman\fcharset0 Palatino-Roman;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\pard\tx560\tx1120\tx1680\pardirnatural\partightenfactor0

\f0\fs26 \cf0 Copyright \'a9 2026 by the fixture author.\
\
All rights reserved. No part of this fixture may be reproduced without asking nicely.\
}`;

const sha1 = (data: string): string => createHash('sha1').update(data).digest('hex');

/**
 * Create the fixture project inside `dir` and return the .scriv path.
 */
export async function createFixtureProject(dir: string): Promise<string> {
	const project = join(dir, 'Fixture.scriv');
	const docDir = join(project, 'Files', 'Data', COPYRIGHT_ID);
	await mkdir(docDir, { recursive: true });
	await writeFile(join(project, 'Fixture.scrivx'), SCRIVX);
	await writeFile(join(docDir, 'content.rtf'), COPYRIGHT_RTF);
	await writeFile(
		join(project, 'Files', 'Data', 'docs.checksum'),
		`${COPYRIGHT_ID.toLowerCase()}/content.rtf=${sha1(COPYRIGHT_RTF)}\n`
	);
	return project;
}
