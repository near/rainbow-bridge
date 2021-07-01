#!/bin/bash
cd cmd/epoch
go build -v
cd ../relayer
go build -v
cd ../cache
go build -v
