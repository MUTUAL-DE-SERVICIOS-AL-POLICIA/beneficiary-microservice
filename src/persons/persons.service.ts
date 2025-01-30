import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatePersonDto, CreatePersonFingerprintDto, UpdatePersonDto } from './dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FingerprintType, Person, PersonAffiliate, PersonFingerprint } from './entities';
import { FilteredPaginationDto } from './dto/filter-person.dto';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { FtpService, NatsService } from 'src/common';
import { RpcException } from '@nestjs/microservices';

@Injectable()
export class PersonsService {
  private readonly logger = new Logger('PersonsService');

  constructor(
    @InjectRepository(Person)
    private readonly personRepository: Repository<Person>,
    @InjectRepository(PersonFingerprint)
    private readonly personFingerprintRepository: Repository<PersonFingerprint>,
    @InjectRepository(FingerprintType)
    private readonly fingerprintTypeRepository: Repository<FingerprintType>,
    @InjectRepository(PersonAffiliate)
    private readonly personAffiliateRepository: Repository<PersonAffiliate>,
    private readonly nats: NatsService,
    private readonly ftp: FtpService,
  ) {}
  async create(createPersonDto: CreatePersonDto) {
    try {
      const person = this.personRepository.create(createPersonDto);
      await this.personRepository.save(person);
      return person;
    } catch (error) {
      this.handleDBException(error);
    }
  }
  async showListFingerprint(): Promise<any> {
    const listFingerprint = await this.fingerprintTypeRepository.find();
    return listFingerprint.map(({ id, name }) => ({ id, name }));
  }

  async findAll(filteredPaginationDto: FilteredPaginationDto) {
    const { limit = 10, page = 1, filter } = filteredPaginationDto;
    const offset = (page - 1) * limit;
    const query = this.personRepository.createQueryBuilder('person');
    if (filter) {
      const formattedFilter = filter.replace(/\s+/g, '').trim();
      query.andWhere(
        ` person.identity_card ILIKE :filter OR
          LOWER(CONCAT(
              person.first_name,
              COALESCE(person.second_name, ''),
              person.last_name,
              COALESCE(person.mothers_last_name, '')
          )) LIKE :filter
        `,
        {
          filter: `%${formattedFilter}%`,
        },
      );
    }
    query.skip(offset).take(limit);
    const [persons, total] = await query.getManyAndCount();
    return {
      persons,
      total,
    };
  }

  async findOnePerson(term: string, field: string): Promise<Person> {
    const queryBuilder = this.personRepository.createQueryBuilder('person');
    const person = await queryBuilder
      .leftJoinAndSelect('person.personAffiliates', 'personAffiliates')
      .leftJoinAndSelect('person.personFingerprints', 'personFingerprints')
      .leftJoinAndSelect('personFingerprints.fingerprintType', 'fingerprintType')
      .where(`person.${field} = :value`, { value: field === 'id' ? +term : term })
      .getOne();
    console.log(term);
    console.log('field', field);
    if (!person) {
      throw new RpcException({
        code: 404,
        message: `Persona: ${term} no encontrada`,
      });
    }
    return person;
  }

  async update(id: number, updatePersonDto: UpdatePersonDto) {
    const person = await this.personRepository.preload({
      id: id,
      ...updatePersonDto,
    });

    if (!person) throw new NotFoundException(`Person with: ${id} not found`);

    try {
      await this.personRepository.save(person);
      return person;
    } catch (error) {
      this.handleDBException(error);
    }
  }

  async remove(id: number) {
    const person = this.personRepository.findOneBy({ id });
    if (person) {
      await this.personRepository.softDelete(id);
      return `This action removes a #${id} person`;
    } else {
      throw new NotFoundException(`Person with: ${id} not found`);
    }
  }

  async findPersonAffiliatesWithDetails(personId: number): Promise<any> {
    const person = await this.findAndVerifyPersonWithRelations(
      personId,
      'personAffiliates',
      'affiliates',
      'type',
    );
    const {
      createdAt,
      updatedAt,
      deletedAt,
      uuidColumn,
      cityBirthId,
      pensionEntityId,
      financialEntityId,
      nua,
      idPersonSenasir,
      dateLastContribution,
      personAffiliates,
      ...dataPerson
    } = person;
    const personAffiliate = await Promise.all(
      personAffiliates.map(async (personAffiliate) => {
        const { kinshipType, createdAt, updatedAt, deletedAt, ...dataPersonAffiliate } =
          personAffiliate;
        const kinship = await this.nats.fetchAndClean(kinshipType, 'kinships.findOne', [
          'createdAt',
          'updatedAt',
          'deletedAt',
        ]);
        return {
          ...dataPersonAffiliate,
          kinship,
        };
      }),
    );
    const [cityBirth, pensionEntity, financialEntity] = await Promise.all([
      this.nats.fetchAndClean(cityBirthId, 'cities.findOne', [
        'secondShortened',
        'thirdShortened',
        'toBank',
        'latitude',
        'longitude',
        'companyAddress',
        'phonePrefix',
        'companyPhones',
        'companyCellphones',
      ]),
      this.nats.fetchAndClean(pensionEntityId, 'pensionEntities.findOne', ['type', 'isActive']),
      this.nats.fetchAndClean(financialEntityId, 'financialEntities.findOne', [
        'createdAt',
        'updatedAt',
      ]),
    ]);
    const birthDateLiteral = format(person.birthDate, "d 'de' MMMM 'de' yyyy", { locale: es });
    return {
      ...dataPerson,
      birthDateLiteral: birthDateLiteral,
      personAffiliate,
      cityBirth,
      pensionEntity,
      financialEntity,
    };
  }

  async findAffiliteRelatedWithPerson(id: number): Promise<any> {
    const personAffiliates = await this.findAndVerifyPersonWithRelations(
      id,
      'personAffiliates',
      'persons',
      'type',
    );
    return personAffiliates;
  }

  async showPersonsRelatedToAffiliate(id: number): Promise<any> {
    const dependents = await this.personAffiliateRepository.find({
      where: {
        typeId: id,
        type: 'persons',
      },
      relations: ['person'],
    });
    const personAffiliate = await Promise.all(
      dependents.map(async (personAffiliate) => {
        const { person, kinshipType, createdAt, updatedAt, deletedAt, ...dataPersonAffiliate } =
          personAffiliate;
        const kinship = await this.nats.fetchAndClean(kinshipType, 'kinships.findOne', [
          'createdAt',
          'updatedAt',
          'deletedAt',
        ]);
        const personInfo = personAffiliate.person
          ? {
              full_name: [
                personAffiliate.person.firstName,
                personAffiliate.person.secondName,
                personAffiliate.person.lastName,
                personAffiliate.person.mothersLastName,
              ]
                .filter(Boolean)
                .join(' '),
              identityCard: personAffiliate.person.identityCard,
            }
          : null;

        return {
          ...dataPersonAffiliate,
          kinship,
          person: personInfo,
        };
      }),
    );
    return personAffiliate;
  }

  async createPersonFingerPrint(
    createPersonFingerprintDto: CreatePersonFingerprintDto,
  ): Promise<{ message: string; registros: { success: string[]; error: string[] } }> {
    const { personId, fingerprints } = createPersonFingerprintDto;

    const [person] = await Promise.all([
      this.findOnePerson(`${personId}`, 'id'),
      this.ftp.connectToFtp(),
    ]);

    const uploadResults = await fingerprints.reduce(
      async (accPromise, fingerprint) => {
        const acc = await accPromise;
        const { wsq, quality, fingerprintTypeId } = fingerprint;
        const buffer = Buffer.from(wsq, 'base64');
        const personFingerprints = await this.personFingerprintRepository.find({
          where: { person: { id: personId }, fingerprintType: { id: fingerprintTypeId } },
          relations: ['fingerprintType'],
        });
        const initialPath = `Person/Fingerprints/${personId}/`;
        const existingFingerprint = personFingerprints.find((fp) => fp.quality === quality);
        if (existingFingerprint) {
          acc.error.push(`Ya existe una huella con calidad ${quality}, no se subirá nuevamente.`);
          return acc;
        }
        if (personFingerprints.length < 3) {
          const fingerprintType = await this.fingerprintTypeRepository.findOne({
            where: { id: fingerprintTypeId },
          });
          if (!fingerprintType) {
            throw new RpcException(`Tipo de huella con ID ${fingerprintTypeId} no encontrado`);
          }
          const path = `${initialPath}${fingerprintType.short_name}_${quality}.wsq`;
          await this.ftp.uploadFile(buffer, initialPath, path);
          const newPersonFingerprint = this.personFingerprintRepository.create({
            person,
            quality,
            fingerprintType,
            path,
          });
          await this.personFingerprintRepository.save(newPersonFingerprint);
          acc.success.push(`Huella registrada con calidad ${quality}: ${path}`);
          return acc;
        }
        const fingerprintMinQuality = personFingerprints.reduce(
          (min, current) => (current.quality < min.quality ? current : min),
          personFingerprints[0],
        );
        if (quality > fingerprintMinQuality.quality) {
          const remove_path = fingerprintMinQuality.path;
          const fingerprintType = fingerprintMinQuality.fingerprintType;
          fingerprintMinQuality.quality = quality;
          fingerprintMinQuality.path = `${initialPath}${fingerprintType.short_name}_${quality}.wsq`;
          fingerprintMinQuality.updatedAt = new Date();
          await this.ftp.removeFile(remove_path);
          await this.ftp.uploadFile(buffer, initialPath, fingerprintMinQuality.path);
          await this.personFingerprintRepository.save(fingerprintMinQuality);
          acc.success.push(
            `Huella reemplazada con calidad ${quality}: ${fingerprintMinQuality.path}`,
          );
        } else {
          acc.error.push(
            `La calidad ${quality} no es suficiente para reemplazar la huella de menor calidad.`,
          );
        }
        return acc;
      },
      Promise.resolve({ success: [], error: [] }),
    );
    let message = '';
    if (uploadResults.success.length > 0 && uploadResults.error.length > 0) {
      message = `Algunas huellas fueron registradas y otras no debido a calidad duplicada o insuficiente.`;
    } else if (uploadResults.success.length > 0) {
      message = `Las huellas se han registrado correctamente.`;
    } else {
      message = `No se registraron huellas porque ya existían con las mismas calidades o porque la calidad era insuficiente.`;
    }
    await this.ftp.onDestroy();
    return {
      message,
      registros: {
        success: uploadResults.success,
        error: uploadResults.error,
      },
    };
  }

  async showFingerprintRegistered(personId: number): Promise<any> {
    const person = await this.personRepository.findOne({
      where: { id: personId },
      relations: ['personFingerprints', 'personFingerprints.fingerprintType'],
    });
    const fingerprints = person.personFingerprints.map((fingerprint) => ({
      id: fingerprint.fingerprintType.id,
      name: fingerprint.fingerprintType.name,
    }));
    return { fingerprints };
  }

  async getFingerprintComparison(personId: number): Promise<any> {
    const person = await this.findOnePerson(`${personId}`, 'id');
    if (person.personFingerprints.length === 0) {
      throw new RpcException({
        message: `Person with ID: ${personId} not found`,
        code: 404,
      });
    }
    const fingerprintsData = [];
    try {
      await this.ftp.connectToFtp();
      for (const fingerprint of person.personFingerprints) {
        try {
          console.log(`Processing fingerprint ID: ${fingerprint.id}`);
          const fileBuffer = await this.ftp.downloadFile(fingerprint.path);
          const wsqBase64 = fileBuffer.toString('base64');
          fingerprintsData.push({
            id: fingerprint.id,
            quality: fingerprint.quality,
            fingerprintType: fingerprint.fingerprintType,
            wsqBase64,
          });
        } catch (error) {
          console.error(`Failed to download file at path: ${fingerprint.path}`, error);
          throw new Error(`Failed to download file at path: ${fingerprint.path}`);
        }
      }
    } finally {
      await this.ftp.onDestroy();
    }
    return fingerprintsData;
  }

  private handleDBException(error: any) {
    if (error.code === '23505') throw new BadRequestException(error.detail);
    this.logger.error(error);
    throw new InternalServerErrorException('Unexecpected Error');
  }

  private async findAndVerifyPersonWithRelations(
    id: number,
    relation: string,
    registration: string,
    field: string,
  ): Promise<Person | null> {
    let person = null;
    try {
      person = await this.personRepository.findOne({
        where: { id },
        relations: [relation],
      });
    } catch (error) {
      throw new RpcException({ message: error.message, code: 400 });
    }
    if (!person) {
      throw new RpcException({ message: `Affiliate with ID: ${id} not found`, code: 404 });
    }
    if (!person[relation]) {
      throw new RpcException({ message: `campo ${relation} no existe en person`, code: 404 });
    }
    const filteredRelatedData = person[relation].filter(
      (related) => related[field] === registration,
    );
    return {
      ...person,
      personAffiliates: filteredRelatedData,
    };
  }
}
