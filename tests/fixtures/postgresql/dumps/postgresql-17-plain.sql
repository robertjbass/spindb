--
-- PostgreSQL database dump
--

-- Dumped from database version 17.0
-- Dumped by pg_dump version 17.0

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: test_table; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.test_table (
    id serial PRIMARY KEY,
    name text NOT NULL
);

--
-- Name: test_table_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.test_table_id_seq OWNED BY public.test_table.id;

--
-- Data for Name: test_table; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO public.test_table VALUES (1, 'Test row 1');
INSERT INTO public.test_table VALUES (2, 'Test row 2');

--
-- PostgreSQL database dump complete
--
